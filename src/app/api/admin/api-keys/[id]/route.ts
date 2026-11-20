import { revokeApiKey } from "@/lib/data/api-keys";
import { apiError, requireSession } from "@/lib/http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireSession(req, { role: "admin", mutation: true });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return apiError(404, "not_found");
  const revoked = await revokeApiKey(auth.session.tenantId, id);
  return revoked ? new Response(null, { status: 204 }) : apiError(404, "not_found");
}
