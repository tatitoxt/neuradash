import { apiError, json, readJson, jsonObject, requireSession } from "@/lib/http";
import {
  ALERT_METRICS,
  ALERT_OPS,
  createAlertRule,
  listAlertEvents,
  listAlertRules,
  type AlertMetric,
  type AlertOp,
} from "@/lib/data/alerts";

export async function GET(req: Request): Promise<Response> {
  const auth = await requireSession(req, { role: "admin" });
  if (!auth.ok) return auth.response;
  const [rules, recent] = await Promise.all([
    listAlertRules(auth.session.tenantId),
    listAlertEvents(auth.session.tenantId),
  ]);
  return json({ rules, recent });
}

const MAX_URL = 2048;

/** POST {name, metric, op, threshold, webhookUrl, cooldownMinutes?} — create a threshold alert rule. */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireSession(req, { role: "admin", mutation: true });
  if (!auth.ok) return auth.response;

  const parsed = await readJson(req, 8 * 1024);
  if (!parsed.ok) return parsed.response;
  const body = jsonObject(parsed.body);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const webhookUrl = typeof body.webhookUrl === "string" ? body.webhookUrl : "";
  const cooldown = body.cooldownMinutes;
  let schemeOk = false;
  try {
    const u = new URL(webhookUrl);
    schemeOk = u.protocol === "http:" || u.protocol === "https:";
  } catch {
    schemeOk = false;
  }
  if (
    name.length < 1 ||
    name.length > 120 ||
    !ALERT_METRICS.includes(body.metric as AlertMetric) ||
    !ALERT_OPS.includes(body.op as AlertOp) ||
    typeof body.threshold !== "number" ||
    !Number.isFinite(body.threshold) ||
    !schemeOk ||
    webhookUrl.length > MAX_URL ||
    (cooldown !== undefined &&
      (typeof cooldown !== "number" || !Number.isInteger(cooldown) || cooldown < 0 || cooldown > 10080))
  ) {
    return apiError(
      422,
      "invalid_body",
      "expected {name, metric: events|errors|revenue|error_rate, op: >|>=|<|<=, threshold, webhookUrl, cooldownMinutes?}",
    );
  }
  const result = await createAlertRule(auth.session.tenantId, {
    name,
    metric: body.metric as AlertMetric,
    op: body.op as AlertOp,
    threshold: body.threshold,
    webhookUrl,
    cooldownMinutes: cooldown as number | undefined,
  });
  if (!result.ok) return apiError(409, "duplicate_name", "an alert rule with that name exists");
  return json({ rule: result.rule }, 201);
}
