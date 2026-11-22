import { apiError, json, readJson, jsonObject, requireSession } from "@/lib/http";
import {
  ALERT_METRICS,
  ALERT_OPS,
  deleteAlertRule,
  updateAlertRule,
  type AlertMetric,
  type AlertOp,
} from "@/lib/data/alerts";

type Params = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PATCH — partial update of a rule (name/metric/op/threshold/webhookUrl/enabled/cooldownMinutes). */
export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  const auth = await requireSession(req, { role: "admin", mutation: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!UUID.test(id)) return apiError(404, "not_found", "alert rule not found");

  const parsed = await readJson(req, 8 * 1024);
  if (!parsed.ok) return parsed.response;
  const body = jsonObject(parsed.body);
  const patch: Parameters<typeof updateAlertRule>[2] = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 120)
      return apiError(422, "invalid_body", "name must be 1-120 chars");
    patch.name = body.name.trim();
  }
  if (body.metric !== undefined) {
    if (!ALERT_METRICS.includes(body.metric as AlertMetric))
      return apiError(422, "invalid_body", "metric must be events|errors|revenue|error_rate");
    patch.metric = body.metric as AlertMetric;
  }
  if (body.op !== undefined) {
    if (!ALERT_OPS.includes(body.op as AlertOp))
      return apiError(422, "invalid_body", "op must be >|>=|<|<=");
    patch.op = body.op as AlertOp;
  }
  if (body.threshold !== undefined) {
    if (typeof body.threshold !== "number" || !Number.isFinite(body.threshold))
      return apiError(422, "invalid_body", "threshold must be a finite number");
    patch.threshold = body.threshold;
  }
  if (body.webhookUrl !== undefined) {
    if (typeof body.webhookUrl !== "string" || body.webhookUrl.length > 2048)
      return apiError(422, "invalid_body", "webhookUrl must be a string <= 2048 chars");
    try {
      const u = new URL(body.webhookUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      return apiError(422, "invalid_body", "webhookUrl must be http(s)");
    }
    patch.webhookUrl = body.webhookUrl;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean")
      return apiError(422, "invalid_body", "enabled must be boolean");
    patch.enabled = body.enabled;
  }
  if (body.cooldownMinutes !== undefined) {
    const c = body.cooldownMinutes;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 0 || c > 10080)
      return apiError(422, "invalid_body", "cooldownMinutes must be an int 0-10080");
    patch.cooldownMinutes = c;
  }
  if (Object.keys(patch).length === 0) return apiError(422, "invalid_body", "no supported fields to update");
  const rule = await updateAlertRule(auth.session.tenantId, id, patch);
  if (rule === "duplicate") return apiError(409, "duplicate", "an alert rule with that name already exists");
  if (!rule) return apiError(404, "not_found", "alert rule not found");
  return json({ rule });
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  const auth = await requireSession(req, { role: "admin", mutation: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!UUID.test(id)) return apiError(404, "not_found", "alert rule not found");
  const removed = await deleteAlertRule(auth.session.tenantId, id);
  if (!removed) return apiError(404, "not_found", "alert rule not found");
  return json({ deleted: true });
}
