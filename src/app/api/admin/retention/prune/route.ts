import { json, requireSession } from "@/lib/http";
import { pruneEvents } from "@/lib/data/retention";

/** POST — run the tenant's retention prune now (a cron job can hit the same function). */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireSession(req, { role: "admin", mutation: true });
  if (!auth.ok) return auth.response;
  return json({ deleted: await pruneEvents(auth.session.tenantId) });
}
