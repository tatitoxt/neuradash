import { z } from "zod";
import { confirmEnrollment } from "@/lib/auth/mfa";
import { apiError, json, readJson, requireSession } from "@/lib/http";

const bodySchema = z.object({ code: z.string().min(6).max(10) });

/** POST {code} — confirm enrollment with a live TOTP code and enable MFA. */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireSession(req, { mutation: true });
  if (!auth.ok) return auth.response;
  const raw = await readJson(req, 4096);
  if (!raw.ok) return raw.response;
  const parsed = bodySchema.safeParse(raw.body);
  if (!parsed.success) return apiError(400, "invalid_request", "code is required");
  if (!(await confirmEnrollment(auth.session.userId, parsed.data.code.replace(/\s/g, "")))) {
    return apiError(400, "invalid_code", "the code does not match — check the secret and try again");
  }
  return json({ enabled: true });
}
