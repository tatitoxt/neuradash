import { z } from "zod";
import { beginEnrollment, disableMfa, mfaEnabled, recoveryCodeCount } from "@/lib/auth/mfa";
import { apiError, json, readJson, requireSession } from "@/lib/http";

/** GET — whether TOTP MFA gates sign-ins, plus remaining recovery codes. */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const enabled = await mfaEnabled(auth.session.userId);
  return json({ enabled, codesRemaining: enabled ? await recoveryCodeCount(auth.session.userId) : 0 });
}

/** POST — start enrollment: returns a fresh secret + otpauth URI (disabled
 * until /api/me/mfa/confirm verifies a code against it). */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireSession(req, { mutation: true });
  if (!auth.ok) return auth.response;
  const enrollment = await beginEnrollment(auth.session.userId, auth.session.email);
  return json(enrollment);
}

const disableSchema = z.object({ password: z.string().min(1).max(256) });

/** DELETE {password} — disable MFA; the current password is required so a
 * stolen session alone cannot strip the second factor. */
export async function DELETE(req: Request): Promise<Response> {
  const auth = await requireSession(req, { mutation: true });
  if (!auth.ok) return auth.response;
  const raw = await readJson(req, 4096);
  if (!raw.ok) return raw.response;
  const parsed = disableSchema.safeParse(raw.body);
  if (!parsed.success) return apiError(400, "invalid_request", "password is required");
  if (!(await disableMfa(auth.session.userId, parsed.data.password))) {
    return apiError(401, "invalid_credentials", "the current password is incorrect");
  }
  return json({ disabled: true });
}
