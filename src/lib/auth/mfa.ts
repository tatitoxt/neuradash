import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mfaChallenges, users } from "@/lib/db/schema";
import { verifyPassword } from "./password";
import { generateSessionToken, sha256Hex } from "./tokens";
import { generateTotpSecret, totpUri, verifyTotp } from "./totp";

export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MFA_MAX_ATTEMPTS = 5;

/** True when the user has a confirmed TOTP enrollment gating sign-in. */
export async function mfaEnabled(userId: string): Promise<boolean> {
  const res = await getDb().execute<{ enabled: boolean }>(
    sql`select enabled from totp_state(${userId}::uuid)`,
  );
  return res.rows[0]?.enabled === true;
}

export type Enrollment = { secret: string; uri: string };

/** Start (or restart) enrollment: stores a disabled secret and returns it
 * for display. The secret only gates logins once confirmed. */
export async function beginEnrollment(userId: string, email: string): Promise<Enrollment> {
  const secret = generateTotpSecret();
  await getDb().execute(sql`select totp_begin(${userId}::uuid, ${secret})`);
  return { secret, uri: totpUri(secret, email) };
}

/** Confirm enrollment with a live TOTP code; enables MFA on success. */
export async function confirmEnrollment(userId: string, code: string): Promise<boolean> {
  const res = await getDb().execute<{ secret: string; enabled: boolean }>(
    sql`select secret, enabled from totp_state(${userId}::uuid)`,
  );
  const row = res.rows[0];
  if (!row || row.enabled || !verifyTotp(row.secret, code)) return false;
  const out = await getDb().execute<{ totp_enable: boolean }>(
    sql`select totp_enable(${userId}::uuid)`,
  );
  return out.rows[0]?.totp_enable === true;
}

/** Disable MFA; requires the current password, like changing it. */
export async function disableMfa(userId: string, password: string): Promise<boolean> {
  const [user] = await getDb().select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !(await verifyPassword(password, user.passwordHash))) return false;
  await getDb().execute(sql`select totp_disable(${userId}::uuid)`);
  return true;
}

/** Password step succeeded but MFA is enabled: issue a one-shot challenge
 * (hashed at rest, 5-minute TTL, 5 attempts) instead of a session. */
export async function createMfaChallenge(userId: string, tenantSlug: string): Promise<string> {
  const token = generateSessionToken();
  await getDb().insert(mfaChallenges).values({
    userId,
    tenantSlug,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MS),
  });
  return token;
}

export type MfaResult =
  | { ok: true; userId: string; tenantSlug: string }
  | { ok: false; reason: "invalid_challenge" | "too_many_attempts" | "invalid_code" };

/** Second factor step: verify the code against the enrolled secret and
 * consume the challenge atomically (DELETE ... RETURNING). */
export async function consumeMfaChallenge(token: string, code: string): Promise<MfaResult> {
  const db = getDb();
  const [challenge] = await db
    .select()
    .from(mfaChallenges)
    .where(and(eq(mfaChallenges.tokenHash, sha256Hex(token)), gt(mfaChallenges.expiresAt, sql`now()`)))
    .limit(1);
  if (!challenge) return { ok: false, reason: "invalid_challenge" };
  if (challenge.attempts >= MFA_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

  const res = await db.execute<{ secret: string; enabled: boolean }>(
    sql`select secret, enabled from totp_state(${challenge.userId}::uuid)`,
  );
  const row = res.rows[0];
  if (!row || !row.enabled || !verifyTotp(row.secret, code)) {
    const attempts = challenge.attempts + 1;
    if (attempts >= MFA_MAX_ATTEMPTS) {
      await db.delete(mfaChallenges).where(eq(mfaChallenges.id, challenge.id));
    } else {
      await db.update(mfaChallenges).set({ attempts }).where(eq(mfaChallenges.id, challenge.id));
    }
    return { ok: false, reason: attempts >= MFA_MAX_ATTEMPTS ? "too_many_attempts" : "invalid_code" };
  }
  await db.delete(mfaChallenges).where(eq(mfaChallenges.id, challenge.id));
  return { ok: true, userId: challenge.userId, tenantSlug: challenge.tenantSlug };
}
