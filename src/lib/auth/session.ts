import { and, eq, gt, ne, sql } from "drizzle-orm";
import { getDb, withTenant, withUser } from "@/lib/db/client";
import { memberships, mfaChallenges, sessions, tenants, users, type Role } from "@/lib/db/schema";
import { consumeMfaChallenge, createMfaChallenge, mfaEnabled } from "./mfa";
import { hashPassword, verifyPassword } from "./password";
import { generateSessionToken, sha256Hex } from "./tokens";

export const SESSION_COOKIE = "nd_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type Session = {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  role: Role;
  expiresAt: Date;
};

export type LoginResult =
  | { ok: true; token: string; session: Session }
  | { ok: true; mfa: true; challenge: string }
  | { ok: false; reason: LoginFailure };

export type LoginFailure =
  | "invalid_credentials"
  | "no_membership"
  | "invalid_challenge"
  | "too_many_attempts"
  | "invalid_code";

// Verifying against a fixed hash keeps response time similar for unknown emails.
const DUMMY_HASH =
  "scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export async function login(email: string, password: string, tenantSlug?: string): Promise<LoginResult> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid) return { ok: false, reason: "invalid_credentials" };

  const own = await withUser(user.id, (tx) =>
    tx
      .select({ tenantId: tenants.id, slug: tenants.slug, role: memberships.role })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(eq(memberships.userId, user.id))
      .orderBy(tenants.slug),
  );
  const membership = tenantSlug ? own.find((m) => m.slug === tenantSlug) : own[0];
  if (!membership) return { ok: false, reason: "no_membership" };

  if (await mfaEnabled(user.id)) {
    // Password verified — the session is only minted after the TOTP step.
    const challenge = await createMfaChallenge(user.id, membership.slug);
    return { ok: true, mfa: true, challenge };
  }
  return createSession(user.id, membership.tenantId, user.passwordHash);
}

/** Second step of sign-in when MFA is enabled: consumes the one-shot
 * challenge and mints the session for the tenant chosen at the password step. */
export async function completeMfaLogin(challenge: string, code: string): Promise<LoginResult> {
  const result = await consumeMfaChallenge(challenge, code);
  if (!result.ok) return { ok: false, reason: result.reason };

  const own = await withUser(result.userId, (tx) =>
    tx
      .select({ tenantId: tenants.id, slug: tenants.slug })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(eq(memberships.userId, result.userId))
      .orderBy(tenants.slug),
  );
  const membership = result.tenantSlug ? own.find((m) => m.slug === result.tenantSlug) : own[0];
  if (!membership) return { ok: false, reason: "no_membership" };
  return createSession(result.userId, membership.tenantId);
}

/** `verifiedHash`: the password hash the caller checked. The session is only
 * created while it is still current, so a login that verified the old
 * password cannot outlive a concurrent password change. */
async function createSession(userId: string, tenantId: string, verifiedHash?: string): Promise<LoginResult> {
  const db = getDb();
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  if (verifiedHash === undefined) {
    await db.insert(sessions).values({ tokenHash: sha256Hex(token), userId, tenantId, expiresAt });
  } else {
    const inserted = await db.execute(sql`
      insert into sessions (token_hash, user_id, tenant_id, expires_at)
      select ${sha256Hex(token)}, ${userId}::uuid, ${tenantId}::uuid, ${expiresAt}
      where exists (select 1 from users where id = ${userId}::uuid and password_hash = ${verifiedHash})`);
    if (inserted.rowCount !== 1) return { ok: false, reason: "invalid_credentials" };
  }
  const session = await getSession(token);
  if (!session) throw new Error("session vanished right after creation");
  return { ok: true, token, session };
}

/**
 * Resolves a session token. The role is re-read from `memberships` under the session's
 * tenant on every call, so a revoked membership or role change applies immediately.
 */
export async function getSession(token: string | undefined | null): Promise<Session | null> {
  if (!token || token.length > 128) return null;
  const db = getDb();
  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      email: users.email,
      name: users.name,
      tenantId: sessions.tenantId,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), gt(sessions.expiresAt, sql`now()`)))
    .limit(1);
  if (!row) return null;

  const [member] = await withTenant(row.tenantId, (tx) =>
    tx
      .select({ role: memberships.role, slug: tenants.slug, tenantName: tenants.name })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(and(eq(memberships.tenantId, row.tenantId), eq(memberships.userId, row.userId)))
      .limit(1),
  );
  if (!member) return null;
  return { ...row, role: member.role, tenantSlug: member.slug, tenantName: member.tenantName };
}

/**
 * Points an existing session at another tenant the user belongs to. Role keeps
 * being re-resolved from `memberships` on every request, so switching into a
 * tenant where the user is a viewer drops admin rights immediately.
 */
export async function switchTenant(token: string | undefined | null, tenantSlug: string): Promise<Session | null> {
  if (!token || !tenantSlug || tenantSlug.length > 100) return null;
  const db = getDb();
  const [row] = await db
    .select({ sessionId: sessions.id, userId: sessions.userId })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), gt(sessions.expiresAt, sql`now()`)))
    .limit(1);
  if (!row) return null;

  const [membership] = await withUser(row.userId, (tx) =>
    tx
      .select({ tenantId: memberships.tenantId })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(and(eq(memberships.userId, row.userId), eq(tenants.slug, tenantSlug)))
      .limit(1),
  );
  if (!membership) return null;

  await db.update(sessions).set({ tenantId: membership.tenantId }).where(eq(sessions.id, row.sessionId));
  return getSession(token);
}

export async function deleteSession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await getDb().delete(sessions).where(eq(sessions.tokenHash, sha256Hex(token)));
}

export function sessionCookieSecure(): boolean {
  const flag = process.env.COOKIE_SECURE;
  if (flag === "true") return true;
  if (flag === "false") return false;
  return process.env.NODE_ENV === "production";
}

export function serializeSessionCookie(token: string, maxAgeMs = SESSION_TTL_MS): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (sessionCookieSecure()) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return serializeSessionCookie("", 0);
}

export type PasswordChangeResult = "ok" | "invalid_current" | "weak_password";

/**
 * Self-service password rotation. Verifies the current password first, then
 * updates the hash through the SECURITY DEFINER `change_user_password`
 * function (the app role cannot UPDATE `users` directly) and kills every
 * other session of the user so a leaked temp password stops working.
 */
export async function changePassword(
  session: Session,
  current: string,
  next: string,
): Promise<PasswordChangeResult> {
  if (next.length < 10 || next.length > 256 || next === current) return "weak_password";
  const [user] = await getDb()
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  if (!user || !(await verifyPassword(current, user.passwordHash))) return "invalid_current";
  const passwordHash = await hashPassword(next);
  // Compare-and-swap on the verified hash: of two overlapping changes only one wins.
  const res = await getDb().execute<{ changed: boolean }>(
    sql`select change_user_password(${session.userId}::uuid, ${user.passwordHash}, ${passwordHash}) as changed`,
  );
  if (!res.rows[0]?.changed) return "invalid_current";
  await getDb()
    .delete(sessions)
    .where(and(eq(sessions.userId, session.userId), ne(sessions.id, session.sessionId)));
  // Pending MFA logins were authorized by the old password.
  await getDb().delete(mfaChallenges).where(eq(mfaChallenges.userId, session.userId));
  return "ok";
}
