import { getMetrics } from "@/lib/data/metrics";
import { json, requireReadAccess } from "@/lib/http";
import { parseRange } from "@/lib/range";

export async function GET(req: Request): Promise<Response> {
  const auth = await requireReadAccess(req);
  if (!auth.ok) return auth.response;
  const range = parseRange(new URL(req.url).searchParams.get("range"));
  return json(await getMetrics(auth.tenantId, range));
}
