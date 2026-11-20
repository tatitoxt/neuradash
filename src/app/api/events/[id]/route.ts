import { getEvent } from "@/lib/data/events";
import { apiError, json, requireSession } from "@/lib/http";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return apiError(400, "invalid_id");
  // Events of other tenants are indistinguishable from missing ones.
  const event = await getEvent(auth.session.tenantId, id);
  return event ? json({ event }) : apiError(404, "not_found");
}
