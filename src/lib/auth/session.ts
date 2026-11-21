import { and, eq, gt, sql } from "drizzle-orm";
import { getDb, withTenant, withUser } from "@/lib/db/client";
import { memberships, sessions, tenants, users, type Role } from "@/lib/db/schema";
import { verifyPassword } from "./password";
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
  | { ok: false; reason: "invalid_credentials" | "no_membership" };

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

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    tokenHash: sha256Hex(token),
    userId: user.id,
    tenantId: membership.tenantId,
    expiresAt,
  });
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
