import { z } from "zod";
import { login, serializeSessionCookie } from "@/lib/auth/session";
import { apiError, isSameOrigin, json, readJson } from "@/lib/http";
import { FixedWindowLimiter } from "@/lib/rate-limit";

const bodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
  tenant: z.string().max(64).optional(),
});

const limiter = new FixedWindowLimiter(10, 5 * 60_000);

export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req.headers)) return apiError(403, "forbidden", "cross-origin request rejected");
  const raw = await readJson(req, 4096);
  if (!raw.ok) return raw.response;
  const parsed = bodySchema.safeParse(raw.body);
  if (!parsed.success) return apiError(400, "invalid_request", "email and password are required");

  const email = parsed.data.email.trim().toLowerCase();
  if (!limiter.take(email)) return apiError(429, "too_many_attempts", "try again in a few minutes");

  const result = await login(email, parsed.data.password, parsed.data.tenant);
  if (!result.ok) return apiError(401, "invalid_credentials", "invalid email or password");

  limiter.reset(email);
  const { tenantSlug, role, name } = result.session;
  return json({ tenant: tenantSlug, role, name }, 200, { "Set-Cookie": serializeSessionCookie(result.token) });
}
