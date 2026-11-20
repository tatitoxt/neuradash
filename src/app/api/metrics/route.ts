import { getMetrics } from "@/lib/data/metrics";
import { json, requireSession } from "@/lib/http";
import { parseRange } from "@/lib/range";

export async function GET(req: Request): Promise<Response> {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const range = parseRange(new URL(req.url).searchParams.get("range"));
  return json(await getMetrics(auth.session.tenantId, range));
}
