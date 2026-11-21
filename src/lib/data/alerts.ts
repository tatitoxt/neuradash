import { and, desc, eq, sql } from "drizzle-orm";
import { alertEvents, alertRules } from "@/lib/db/schema";
import type { Tx } from "@/lib/db/client";
import { withTenant } from "@/lib/db/client";

export const ALERT_METRICS = ["events", "errors", "revenue", "error_rate"] as const;
export const ALERT_OPS = [">", ">=", "<", "<="] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];
export type AlertOp = (typeof ALERT_OPS)[number];

export interface AlertRuleDTO {
  id: string;
  name: string;
  metric: AlertMetric;
  op: AlertOp;
  threshold: number;
  webhookUrl: string;
  enabled: boolean;
  cooldownMinutes: number;
  lastFiredAt: string | null;
  createdAt: string;
}

export interface FiredAlert {
  ruleId: string;
  alertEventId: number;
  name: string;
  metric: AlertMetric;
  op: AlertOp;
  threshold: number;
  observed: number;
  webhookUrl: string;
}

function toRuleDTO(r: typeof alertRules.$inferSelect): AlertRuleDTO {
  return {
    id: r.id,
    name: r.name,
    metric: r.metric as AlertMetric,
    op: r.op as AlertOp,
    threshold: r.threshold,
    webhookUrl: r.webhookUrl,
    enabled: r.enabled,
    cooldownMinutes: r.cooldownMinutes,
    lastFiredAt: r.lastFiredAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

function compare(op: AlertOp, observed: number, threshold: number): boolean {
  switch (op) {
    case ">": return observed > threshold;
    case ">=": return observed >= threshold;
    case "<": return observed < threshold;
    case "<=": return observed <= threshold;
  }
}

function observedValue(metric: AlertMetric, rollup: { events: number; errors: number; revenue: number }): number {
  switch (metric) {
    case "events": return rollup.events;
    case "errors": return rollup.errors;
    case "revenue": return rollup.revenue;
    case "error_rate": return rollup.events > 0 ? (rollup.errors / rollup.events) * 100 : 0;
  }
}

/**
 * Evaluates enabled rules for the tenant against the rollups of the minutes
 * just written. Runs inside the ingest transaction so firing is atomic with
 * the data that triggered it; outbound delivery happens after commit via the
 * collected `fired` list (webhooks never run inside a DB transaction).
 */
export async function evaluateAlertRules(
  tx: Tx,
  tenantId: string,
  buckets: number[],
  fired: FiredAlert[],
): Promise<void> {
  if (buckets.length === 0) return;
  const rules = await tx
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.tenantId, tenantId), eq(alertRules.enabled, true)));
  const active = rules.filter(
    (r) =>
      r.lastFiredAt == null ||
      Date.now() - r.lastFiredAt.getTime() >= r.cooldownMinutes * 60_000,
  );
  if (active.length === 0) return;

  for (const bucket of buckets) {
    const rows = await tx.execute<{ events: string; errors: string; revenue: number | string }>(sql`
      select events, errors, revenue from metric_rollups
      where tenant_id = ${tenantId} and bucket_start = ${new Date(bucket)}`);
    const row = rows.rows[0];
    if (!row) continue;
    const rollup = { events: Number(row.events), errors: Number(row.errors), revenue: Number(row.revenue) };
    for (const rule of active) {
      const metric = rule.metric as AlertMetric;
      const observed = observedValue(metric, rollup);
      if (!compare(rule.op as AlertOp, observed, rule.threshold)) continue;
      const [evt] = await tx
        .insert(alertEvents)
        .values({
          tenantId,
          ruleId: rule.id,
          metric,
          observed,
          threshold: rule.threshold,
        })
        .returning({ id: alertEvents.id });
      if (!evt) continue;
      await tx
        .update(alertRules)
        .set({ lastFiredAt: new Date() })
        .where(eq(alertRules.id, rule.id));
      fired.push({
        ruleId: rule.id,
        alertEventId: evt.id,
        name: rule.name,
        metric,
        op: rule.op as AlertOp,
        threshold: rule.threshold,
        observed,
        webhookUrl: rule.webhookUrl,
      });
    }
  }
}

/** POSTs the alert payload to the rule's webhook; delivery failures are recorded, never raised. */
export async function deliverAlert(tenantId: string, alert: FiredAlert): Promise<void> {
  let delivered = false;
  try {
    const url = new URL(alert.webhookUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
    const res = await fetch(alert.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "neuradash.alert",
        rule: alert.name,
        metric: alert.metric,
        op: alert.op,
        threshold: alert.threshold,
        observed: alert.observed,
      }),
      signal: AbortSignal.timeout(3_000),
    });
    delivered = res.ok;
  } catch {
    delivered = false;
  }
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(alertEvents)
      .set({ delivered })
      .where(eq(alertEvents.id, alert.alertEventId));
  });
}

export async function listAlertRules(tenantId: string): Promise<AlertRuleDTO[]> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select().from(alertRules).where(eq(alertRules.tenantId, tenantId)).orderBy(alertRules.name),
  );
  return rows.map(toRuleDTO);
}

export async function createAlertRule(
  tenantId: string,
  input: {
    name: string;
    metric: AlertMetric;
    op: AlertOp;
    threshold: number;
    webhookUrl: string;
    cooldownMinutes?: number;
  },
): Promise<{ ok: true; rule: AlertRuleDTO } | { ok: false; reason: "duplicate" }> {
  try {
    const [row] = await withTenant(tenantId, (tx) =>
      tx
        .insert(alertRules)
        .values({
          tenantId,
          name: input.name,
          metric: input.metric,
          op: input.op,
          threshold: input.threshold,
          webhookUrl: input.webhookUrl,
          cooldownMinutes: input.cooldownMinutes ?? 15,
        })
        .returning(),
    );
    if (!row) throw new Error("insert returned no row");
    return { ok: true, rule: toRuleDTO(row) };
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    if (err.code === "23505" || err.cause?.code === "23505") return { ok: false, reason: "duplicate" };
    throw e;
  }
}

export async function updateAlertRule(
  tenantId: string,
  id: string,
  patch: Partial<{
    name: string;
    metric: AlertMetric;
    op: AlertOp;
    threshold: number;
    webhookUrl: string;
    enabled: boolean;
    cooldownMinutes: number;
  }>,
): Promise<AlertRuleDTO | null> {
  const sets: Partial<typeof alertRules.$inferInsert> = {};
  if (patch.name !== undefined) sets.name = patch.name;
  if (patch.metric !== undefined) sets.metric = patch.metric;
  if (patch.op !== undefined) sets.op = patch.op;
  if (patch.threshold !== undefined) sets.threshold = patch.threshold;
  if (patch.webhookUrl !== undefined) sets.webhookUrl = patch.webhookUrl;
  if (patch.enabled !== undefined) sets.enabled = patch.enabled;
  if (patch.cooldownMinutes !== undefined) sets.cooldownMinutes = patch.cooldownMinutes;
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .update(alertRules)
      .set(sets)
      .where(and(eq(alertRules.id, id), eq(alertRules.tenantId, tenantId)))
      .returning(),
  );
  return row ? toRuleDTO(row) : null;
}

export async function deleteAlertRule(tenantId: string, id: string): Promise<boolean> {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .delete(alertRules)
      .where(and(eq(alertRules.id, id), eq(alertRules.tenantId, tenantId)))
      .returning({ id: alertRules.id }),
  );
  return rows.length > 0;
}

export interface AlertEventDTO {
  id: number;
  ruleId: string;
  ruleName: string;
  metric: AlertMetric;
  observed: number;
  threshold: number;
  delivered: boolean;
  firedAt: string;
}

export async function listAlertEvents(tenantId: string, limit = 50): Promise<AlertEventDTO[]> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select({ evt: alertEvents, ruleName: alertRules.name })
      .from(alertEvents)
      .innerJoin(alertRules, eq(alertEvents.ruleId, alertRules.id))
      .where(eq(alertEvents.tenantId, tenantId))
      .orderBy(desc(alertEvents.firedAt))
      .limit(limit),
  );
  return rows.map((r) => ({
    id: r.evt.id,
    ruleId: r.evt.ruleId,
    ruleName: r.ruleName,
    metric: r.evt.metric as AlertMetric,
    observed: r.evt.observed,
    threshold: r.evt.threshold,
    delivered: r.evt.delivered,
    firedAt: r.evt.firedAt.toISOString(),
  }));
}
