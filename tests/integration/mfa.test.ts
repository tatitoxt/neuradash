import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  beginEnrollment,
  confirmEnrollment,
  disableMfa,
  mfaEnabled,
  recoveryCodeCount,
  regenerateRecoveryCodes,
} from "@/lib/auth/mfa";
import { totpNow } from "@/lib/auth/totp";
import { completeMfaLogin, login } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { DEMO_PASSWORD } from "@/lib/seed";
import { reseed } from "./helpers";

const EMAIL = "admin@acme.test";

async function enrolledUser() {
  await reseed(0);
  const [user] = await getDb().select().from(users).where(eq(users.email, EMAIL)).limit(1);
  const enrollment = await beginEnrollment(user!.id, user!.email);
  const codes = await confirmEnrollment(user!.id, totpNow(enrollment.secret));
  expect(codes).toHaveLength(8);
  return { user: user!, secret: enrollment.secret, codes: codes! };
}

describe("TOTP MFA", () => {
  it("gates login behind a challenge and mints the session on a valid code", async () => {
    const { user, secret } = await enrolledUser();
    expect(await mfaEnabled(user.id)).toBe(true);

    const step1 = await login(user.email, DEMO_PASSWORD);
    expect(step1.ok).toBe(true);
    if (!step1.ok || !("mfa" in step1)) throw new Error("expected mfa challenge");
    expect(step1.challenge).toBeTruthy();

    const step2 = await completeMfaLogin(step1.challenge, totpNow(secret));
    expect(step2.ok).toBe(true);
    if (!step2.ok || "mfa" in step2) throw new Error("expected session");
    expect(step2.session.email).toBe(user.email);

    // The challenge is consumed — replaying it fails.
    const replay = await completeMfaLogin(step1.challenge, totpNow(secret));
    expect(replay.ok).toBe(false);
  });

  it("rejects wrong codes and caps attempts at 5", async () => {
    const { user } = await enrolledUser();
    const step1 = await login(user.email, DEMO_PASSWORD);
    if (!step1.ok || !("mfa" in step1)) throw new Error("expected mfa challenge");

    for (let i = 0; i < 4; i++) {
      const bad = await completeMfaLogin(step1.challenge, "000000");
      expect(bad.ok).toBe(false);
      if (bad.ok) continue;
      expect(bad.reason).toBe("invalid_code");
    }
    const fifth = await completeMfaLogin(step1.challenge, "000000");
    expect(fifth.ok).toBe(false);
    if (!fifth.ok) expect(fifth.reason).toBe("too_many_attempts");
  });

  it("does not gate login before enrollment is confirmed", async () => {
    await reseed(0);
    const [user] = await getDb().select().from(users).where(eq(users.email, EMAIL)).limit(1);
    await beginEnrollment(user!.id, user!.email); // never confirmed
    const result = await login(user!.email, DEMO_PASSWORD);
    expect(result.ok).toBe(true);
    if (result.ok) expect("mfa" in result).toBe(false);
  });

  it("disables MFA only with the current password", async () => {
    const { user } = await enrolledUser();
    expect(await disableMfa(user.id, "wrong-password")).toBe(false);
    expect(await disableMfa(user.id, DEMO_PASSWORD)).toBe(true);
    expect(await mfaEnabled(user.id)).toBe(false);

    const result = await login(user.email, DEMO_PASSWORD);
    expect(result.ok).toBe(true);
    if (result.ok) expect("mfa" in result).toBe(false);
  });

  it("issues one-shot recovery codes at enrollment and accepts one at login", async () => {
    const { user, codes } = await enrolledUser();
    expect(await recoveryCodeCount(user.id)).toBe(8);

    const step1 = await login(user.email, DEMO_PASSWORD);
    if (!step1.ok || !("mfa" in step1)) throw new Error("expected mfa challenge");

    const step2 = await completeMfaLogin(step1.challenge, codes[0]!);
    expect(step2.ok).toBe(true);
    expect(await recoveryCodeCount(user.id)).toBe(7);

    // The same code cannot be replayed.
    const step1b = await login(user.email, DEMO_PASSWORD);
    if (!step1b.ok || !("mfa" in step1b)) throw new Error("expected mfa challenge");
    const replay = await completeMfaLogin(step1b.challenge, codes[0]!);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("invalid_code");
  });

  it("regenerating codes invalidates the whole previous set", async () => {
    const { user, codes } = await enrolledUser();
    const fresh = await regenerateRecoveryCodes(user.id);
    expect(fresh).toHaveLength(8);

    const step1 = await login(user.email, DEMO_PASSWORD);
    if (!step1.ok || !("mfa" in step1)) throw new Error("expected mfa challenge");
    const stale = await completeMfaLogin(step1.challenge, codes[1]!);
    expect(stale.ok).toBe(false);

    const step1b = await login(user.email, DEMO_PASSWORD);
    if (!step1b.ok || !("mfa" in step1b)) throw new Error("expected mfa challenge");
    const works = await completeMfaLogin(step1b.challenge, fresh![0]!);
    expect(works.ok).toBe(true);
  });

  it("dropping MFA clears every recovery code", async () => {
    const { user, codes } = await enrolledUser();
    expect(await disableMfa(user.id, DEMO_PASSWORD)).toBe(true);
    expect(await recoveryCodeCount(user.id)).toBe(0);

    // Re-enrolling produces a fresh set; old codes stay dead.
    const enrollment = await beginEnrollment(user.id, user.email);
    const fresh = await confirmEnrollment(user.id, totpNow(enrollment.secret));
    expect(fresh).toHaveLength(8);
    expect(fresh).not.toContain(codes[0]!);

    const step1 = await login(user.email, DEMO_PASSWORD);
    if (!step1.ok || !("mfa" in step1)) throw new Error("expected mfa challenge");
    const stale = await completeMfaLogin(step1.challenge, codes[0]!);
    expect(stale.ok).toBe(false);
  });

  it("refuses to regenerate codes while MFA is off", async () => {
    await reseed(0);
    const [user] = await getDb().select().from(users).where(eq(users.email, EMAIL)).limit(1);
    expect(await regenerateRecoveryCodes(user!.id)).toBeNull();
  });
});
