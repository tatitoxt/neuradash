import { json, requireSession } from "@/lib/http";
import { listMemberships } from "@/lib/data/members";

export async function GET(req: Request): Promise<Response> {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const { email, name, tenantSlug, tenantName, role, userId } = auth.session;
  const tenants = await listMemberships(userId);
  return json({ email, name, tenant: { slug: tenantSlug, name: tenantName }, role, tenants });
}
