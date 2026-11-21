import { readJson, requireSession, apiError, json, sessionTokenFrom } from "@/lib/http";
import { switchTenant } from "@/lib/auth/session";

/** POST {tenant: slug} — re-points the current session at another of the user's tenants. */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireSession(req, { mutation: true });
  if (!auth.ok) return auth.response;

  const parsed = await readJson(req, 4 * 1024);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as { tenant?: unknown };
  if (typeof body.tenant !== "string") {
    return apiError(422, "invalid_body", "expected {tenant: slug}");
  }

  const session = await switchTenant(sessionTokenFrom(req.headers), body.tenant.trim());
  if (!session) {
    return apiError(403, "no_membership", "not a member of that tenant");
  }
  return json({ tenant: { slug: session.tenantSlug, name: session.tenantName }, role: session.role });
}
