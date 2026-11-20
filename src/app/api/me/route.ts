import { json, requireSession } from "@/lib/http";

export async function GET(req: Request): Promise<Response> {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const { email, name, tenantSlug, tenantName, role } = auth.session;
  return json({ email, name, tenant: { slug: tenantSlug, name: tenantName }, role });
}
