import { z } from "zod";
import { changePassword } from "@/lib/auth/session";
import { apiError, json, readJson, requireSession } from "@/lib/http";

const bodySchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(10).max(256),
});

/** POST {currentPassword, newPassword} — rotate the session user's password.
 * Other sessions are revoked on success. */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireSession(req, { mutation: true });
  if (!auth.ok) return auth.response;
  const raw = await readJson(req, 4096);
  if (!raw.ok) return raw.response;
  const parsed = bodySchema.safeParse(raw.body);
  if (!parsed.success) {
    return apiError(400, "invalid_request", "currentPassword and a newPassword of at least 10 characters are required");
  }
  const result = await changePassword(auth.session, parsed.data.currentPassword, parsed.data.newPassword);
  if (result === "weak_password") {
    return apiError(400, "weak_password", "the new password must differ and be at least 10 characters");
  }
  if (result === "invalid_current") {
    return apiError(401, "invalid_credentials", "the current password is incorrect");
  }
  return json({ changed: true });
}
