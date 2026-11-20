import { listRecentEvents } from "@/lib/data/events";
import { json, requireSession } from "@/lib/http";

export async function GET(req: Request): Promise<Response> {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const params = new URL(req.url).searchParams;
  const limit = Number(params.get("limit") ?? 50);
  const beforeId = Number(params.get("before") ?? 0);
  const events = await listRecentEvents(auth.session.tenantId, {
    limit: Number.isFinite(limit) ? limit : 50,
    beforeId: Number.isSafeInteger(beforeId) && beforeId > 0 ? beforeId : undefined,
  });
  return json({ events });
}
