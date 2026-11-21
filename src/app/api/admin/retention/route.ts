import { apiError, json, readJson, requireSession } from "@/lib/http";
import { getRetentionDays, setRetentionDays } from "@/lib/data/retention";

export async function GET(req: Request): Promise<Response> {
  const auth = await requireSession(req, { role: "admin" });
  if (!auth.ok) return auth.response;
  return json({ retentionDays: await getRetentionDays(auth.session.tenantId) });
}

/** PUT {retentionDays: number|null} — 1..3650 days, or null to keep events forever. */
export async function PUT(req: Request): Promise<Response> {
  const auth = await requireSession(req, { role: "admin", mutation: true });
  if (!auth.ok) return auth.response;

  const parsed = await readJson(req, 4 * 1024);
  if (!parsed.ok) return parsed.response;
  const days = (parsed.body as { retentionDays?: unknown }).retentionDays;
  if (days !== null && (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650)) {
    return apiError(422, "invalid_retention", "retentionDays must be an integer 1..3650 or null");
  }
  await setRetentionDays(auth.session.tenantId, days as number | null);
  return json({ retentionDays: days });
}
