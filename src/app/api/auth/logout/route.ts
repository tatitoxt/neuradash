import { clearSessionCookie, deleteSession } from "@/lib/auth/session";
import { apiError, isSameOrigin, json, sessionTokenFrom } from "@/lib/http";

export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req.headers)) return apiError(403, "forbidden", "cross-origin request rejected");
  await deleteSession(sessionTokenFrom(req.headers));
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}
