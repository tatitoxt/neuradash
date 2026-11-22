import { regenerateRecoveryCodes } from "@/lib/auth/mfa";
import { apiError, json, requireSession } from "@/lib/http";

/** POST — rotate the recovery-code set. Codes come back in the clear exactly
 * once; every previous code stops working immediately. */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireSession(req, { mutation: true });
  if (!auth.ok) return auth.response;
  const codes = await regenerateRecoveryCodes(auth.session.userId);
  if (!codes) return apiError(400, "mfa_not_enabled", "enable two-factor authentication first");
  return json({ recoveryCodes: codes });
}
