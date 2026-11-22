import { z } from "zod";
import { completeMfaLogin, serializeSessionCookie } from "@/lib/auth/session";
import { apiError, isSameOrigin, json, readJson } from "@/lib/http";

const bodySchema = z.object({
  challenge: z.string().min(1).max(256),
  code: z.string().min(6).max(10),
});

/** POST {challenge, code} — second factor of sign-in. Issues the session
 * cookie the password step withheld when the TOTP code verifies. */
export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req.headers)) return apiError(403, "forbidden", "cross-origin request rejected");
  const raw = await readJson(req, 4096);
  if (!raw.ok) return raw.response;
  const parsed = bodySchema.safeParse(raw.body);
  if (!parsed.success) return apiError(400, "invalid_request", "challenge and code are required");

  const result = await completeMfaLogin(parsed.data.challenge, parsed.data.code.replace(/\s/g, ""));
  if (!result.ok) {
    const status =
      result.reason === "too_many_attempts"
        ? 429
        : result.reason === "no_membership"
          ? 403
          : 401;
    const message =
      result.reason === "invalid_challenge"
        ? "challenge expired or unknown — sign in again"
        : result.reason === "too_many_attempts"
          ? "too many failed codes — sign in again"
          : result.reason === "no_membership"
            ? "no tenant membership"
            : "invalid authentication code";
    return apiError(status, result.reason, message);
  }
  if ("mfa" in result) return apiError(500, "unexpected", "nested mfa challenge is not supported");
  const { tenantSlug, role, name } = result.session;
  return json({ tenant: tenantSlug, role, name }, 200, { "Set-Cookie": serializeSessionCookie(result.token) });
}
