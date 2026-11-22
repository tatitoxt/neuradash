import { randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mfaChallenges, users } from "@/lib/db/schema";
import { verifyPassword } from "./password";
import { generateSessionToken, sha256Hex } from "./tokens";
import { generateTotpSecret, matchTotpStep, totpUri, verifyTotp } from "./totp";

export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MFA_MAX_ATTEMPTS = 5;
export const RECOVERY_CODE_COUNT = 8;

// Unambiguous charset: no 0/o, 1/l, i.
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** One-shot recovery codes, shown as `xxxx-xxxx`. Only SHA-256 hashes of the
 * normalized form (lowercase, no separators) ever reach the database. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = Array.from(randomBytes(8), (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("");
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

function recoveryHash(code: string): string {
  return sha256Hex(code.toLowerCase().replace(/[\s-]/g, ""));
}

async function storeRecoveryCodes(userId: string, codes: string[]): Promise<void> {
  const hashes = codes.map(recoveryHash);
  await getDb().execute(
    sql`select totp_codes_set(${userId}::uuid, array(select jsonb_array_elements_text(${JSON.stringify(hashes)}::jsonb)))`,
  );
}

/** True when the user has a confirmed TOTP enrollment gating sign-in. */
export async function mfaEnabled(userId: string): Promise<boolean> {
  const res = await getDb().execute<{ enabled: boolean }>(
    sql`select enabled from totp_state(${userId}::uuid)`,
  );
  return res.rows[0]?.enabled === true;
}

export type Enrollment = { secret: string; uri: string };

/** Start (or restart) a pending enrollment: stores a disabled secret and
 * returns it for display. The secret only gates logins once confirmed.
 * Returns null when MFA is already enabled — replacing a confirmed factor
 * goes through the password-gated disable first. */
export async function beginEnrollment(userId: string, email: string): Promise<Enrollment | null> {
  if (await mfaEnabled(userId)) return null;
  const secret = generateTotpSecret();
  await getDb().execute(sql`select totp_begin(${userId}::uuid, ${secret})`);
  return { secret, uri: totpUri(secret, email) };
}

/** Confirm enrollment with a live TOTP code; enables MFA on success and
 * returns the recovery codes to show once. */
export async function confirmEnrollment(userId: string, code: string): Promise<string[] | null> {
  const res = await getDb().execute<{ secret: string; enabled: boolean }>(
    sql`select secret, enabled from totp_state(${userId}::uuid)`,
  );
  const row = res.rows[0];
  if (!row || row.enabled || !verifyTotp(row.secret, code)) return null;
  const out = await getDb().execute<{ totp_enable: boolean }>(
    sql`select totp_enable(${userId}::uuid)`,
  );
  if (out.rows[0]?.totp_enable !== true) return null;
  const codes = generateRecoveryCodes();
  await storeRecoveryCodes(userId, codes);
  return codes;
}

/** Remaining unused recovery codes, for the account page. */
export async function recoveryCodeCount(userId: string): Promise<number> {
  const res = await getDb().execute<{ totp_codes_count: number }>(
    sql`select totp_codes_count(${userId}::uuid)`,
  );
  return res.rows[0]?.totp_codes_count ?? 0;
}

/** Rotate the whole recovery-code set. Requires MFA to be enabled; every
 * previous code stops working immediately. */
export async function regenerateRecoveryCodes(userId: string): Promise<string[] | null> {
  if (!(await mfaEnabled(userId))) return null;
  const codes = generateRecoveryCodes();
  await storeRecoveryCodes(userId, codes);
  return codes;
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
  // Reserve this attempt atomically, so parallel guesses each count.
  const [challenge] = await db
    .update(mfaChallenges)
    .set({ attempts: sql`${mfaChallenges.attempts} + 1` })
    .where(and(eq(mfaChallenges.tokenHash, sha256Hex(token)), gt(mfaChallenges.expiresAt, sql`now()`)))
    .returning();
  if (!challenge) return { ok: false, reason: "invalid_challenge" };
  if (challenge.attempts > MFA_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

  const res = await db.execute<{ secret: string; enabled: boolean }>(
    sql`select secret, enabled from totp_state(${challenge.userId}::uuid)`,
  );
  const row = res.rows[0];
  const step = row?.enabled ? matchTotpStep(row.secret, code) : null;
  // Each time step is accepted once per user, so an observed code cannot be replayed.
  const totpOk =
    step !== null &&
    (
      await db.execute<{ totp_use_step: boolean }>(
        sql`select totp_use_step(${challenge.userId}::uuid, ${step})`,
      )
    ).rows[0]?.totp_use_step === true;
  // A valid TOTP wins; otherwise the same field accepts a one-shot recovery
  // code, consumed atomically so concurrent guesses cannot reuse it.
  const recoveryOk =
    !totpOk &&
    (
      await db.execute<{ totp_codes_consume: boolean }>(
        sql`select totp_codes_consume(${challenge.userId}::uuid, ${recoveryHash(code)})`,
      )
    ).rows[0]?.totp_codes_consume === true;
  if (!totpOk && !recoveryOk) {
    if (challenge.attempts >= MFA_MAX_ATTEMPTS) {
      await db.delete(mfaChallenges).where(eq(mfaChallenges.id, challenge.id));
      return { ok: false, reason: "too_many_attempts" };
    }
    return { ok: false, reason: "invalid_code" };
  }
  // Only the request that actually deletes the challenge may mint a session.
  const consumed = await db
    .delete(mfaChallenges)
    .where(eq(mfaChallenges.id, challenge.id))
    .returning({ id: mfaChallenges.id });
  if (consumed.length === 0) return { ok: false, reason: "invalid_challenge" };
  return { ok: true, userId: challenge.userId, tenantSlug: challenge.tenantSlug };
}
