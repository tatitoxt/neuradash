import { and, desc, eq, sql } from "drizzle-orm";
import { alertEvents, alertRules } from "@/lib/db/schema";
import type { Tx } from "@/lib/db/client";
import { getDb, withTenant } from "@/lib/db/client";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { publicOnlyLookup, resolvesToPublicAddresses } from "@/lib/net/public-address";

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
    .where(and(eq(alertRules.tenantId, tenantId), eq(alertRules.enabled, true)))
    // Blocks a concurrent rule DELETE until ingest commits, so the alert_events FK cannot fail mid-ingest.
    .for("key share");
  const active = rules.filter(
    (r) =>
      r.lastFiredAt == null ||
      Date.now() - r.lastFiredAt.getTime() >= r.cooldownMinutes * 60_000,
  );
  if (active.length === 0) return;

  const firedNow = new Set<string>();
  for (const bucket of buckets) {
    const rows = await tx.execute<{ events: string; errors: string; revenue: number | string }>(sql`
      select events, errors, revenue from metric_rollups
      where tenant_id = ${tenantId} and bucket_start = ${new Date(bucket)}`);
    const row = rows.rows[0];
    if (!row) continue;
    const rollup = { events: Number(row.events), errors: Number(row.errors), revenue: Number(row.revenue) };
    for (const rule of active) {
      // A batch spanning several minutes fires a rule with a cooldown at most once.
      if (firedNow.has(rule.id) && rule.cooldownMinutes > 0) continue;
      const metric = rule.metric as AlertMetric;
      const observed = observedValue(metric, rollup);
      if (!compare(rule.op as AlertOp, observed, rule.threshold)) continue;
      const [evt] = await tx
        .insert(alertEvents)
        .values({
          tenantId,
          ruleId: rule.id,
          metric,
          op: rule.op,
          observed,
          threshold: rule.threshold,
        })
        .returning({ id: alertEvents.id });
      if (!evt) continue;
      firedNow.add(rule.id);
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

/** Max deliveries per alert event; afterwards next_attempt_at stays NULL (dead-lettered). */
export const MAX_ALERT_ATTEMPTS = 5;

/** Delay before retry n+1, indexed by the attempt that just failed (1-based). */
const RETRY_DELAYS_MS = [30_000, 120_000, 480_000, 1_920_000];

function nextRetryAt(attempts: number): Date | null {
  if (attempts >= MAX_ALERT_ATTEMPTS) return null;
  return new Date(Date.now() + RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1]!);
}

/** POSTs the alert payload; resolves to whether the webhook accepted it. */
async function postAlertWebhook(alert: {
  name: string;
  metric: AlertMetric;
  op: AlertOp;
  threshold: number;
  observed: number;
  webhookUrl: string;
}): Promise<boolean> {
  try {
    const url = new URL(alert.webhookUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    // Tenant admins choose webhook URLs, so by default refuse internal destinations (SSRF):
    // IP literals are checked up front, hostnames at connect time via publicOnlyLookup.
    const allowPrivate = process.env.ALERT_WEBHOOK_ALLOW_PRIVATE === "true";
    if (!allowPrivate && isIP(url.hostname.replace(/^\[|\]$/g, "")) && !(await resolvesToPublicAddresses(url.hostname))) {
      return false;
    }
    const body = JSON.stringify({
      type: "neuradash.alert",
      rule: alert.name,
      metric: alert.metric,
      op: alert.op,
      threshold: alert.threshold,
      observed: alert.observed,
    });
    const status = await postJson(url, body, allowPrivate);
    // Redirects are not followed (they could point anywhere); only 2xx counts.
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}

function postJson(url: URL, body: string, allowPrivate: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: 3_000,
        ...(allowPrivate ? {} : { lookup: publicOnlyLookup }),
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("timeout", () => req.destroy(new Error("webhook timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

/** First delivery attempt right after a rule fires; schedules a retry on failure. */
export async function deliverAlert(tenantId: string, alert: FiredAlert): Promise<void> {
  const delivered = await postAlertWebhook(alert);
  const now = new Date();
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(alertEvents)
      .set({
        delivered,
        attempts: 1,
        deliveredAt: delivered ? now : null,
        nextAttemptAt: delivered ? null : nextRetryAt(1),
      })
      .where(eq(alertEvents.id, alert.alertEventId));
  });
}

/**
 * Retries undelivered alert events whose backoff elapsed. Runs per tenant so
 * RLS is honored; rows are claimed `FOR UPDATE SKIP LOCKED`, so concurrent
 * sweepers on multiple instances never double-deliver. Delivers inside the
 * transaction: a crashed sweeper just releases its locks and the rows stay due.
 */
export async function sweepAlertRetries(limitPerTenant = 10): Promise<number> {
  const db = getDb();
  const tenants = await db.execute<{ tenant_id: string }>(
    sql`select tenant_id from tenants_with_due_alert_retries() as t(tenant_id)`,
  );
  let retried = 0;
  for (const { tenant_id: tenantId } of tenants.rows) {
    retried += await withTenant(tenantId, async (tx) => {
      const rows = await tx.execute<{
        id: string; attempts: number; name: string; metric: string; op: string;
        threshold: number; observed: number; webhook_url: string;
      }>(sql`
        select e.id, e.attempts, r.name, coalesce(e."op", r."op") as op, r.webhook_url, e.metric, e.observed, e.threshold
        from alert_events e join alert_rules r on r.id = e.rule_id
        where not e.delivered and e.next_attempt_at is not null
          and e.next_attempt_at <= now() and r.enabled
        order by e.id
        limit ${limitPerTenant}
        for update of e skip locked`);
      let done = 0;
      for (const row of rows.rows) {
        const attempts = Number(row.attempts) + 1;
        const delivered = await postAlertWebhook({
          name: row.name,
          metric: row.metric as AlertMetric,
          op: row.op as AlertOp,
          threshold: row.threshold,
          observed: row.observed,
          webhookUrl: row.webhook_url,
        });
        const now = new Date();
        await tx
          .update(alertEvents)
          .set({
            delivered,
            attempts,
            deliveredAt: delivered ? now : null,
            nextAttemptAt: delivered ? null : nextRetryAt(attempts),
          })
          .where(eq(alertEvents.id, Number(row.id)));
        done += 1;
      }
      return done;
    });
  }
  return retried;
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code === "23505" || err.cause?.code === "23505";
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
    if (isUniqueViolation(e)) return { ok: false, reason: "duplicate" };
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
): Promise<AlertRuleDTO | null | "duplicate"> {
  const sets: Partial<typeof alertRules.$inferInsert> = {};
  if (patch.name !== undefined) sets.name = patch.name;
  if (patch.metric !== undefined) sets.metric = patch.metric;
  if (patch.op !== undefined) sets.op = patch.op;
  if (patch.threshold !== undefined) sets.threshold = patch.threshold;
  if (patch.webhookUrl !== undefined) sets.webhookUrl = patch.webhookUrl;
  if (patch.enabled !== undefined) sets.enabled = patch.enabled;
  if (patch.cooldownMinutes !== undefined) sets.cooldownMinutes = patch.cooldownMinutes;
  if (Object.keys(sets).length === 0) return null;
  try {
    const [row] = await withTenant(tenantId, (tx) =>
      tx
        .update(alertRules)
        .set(sets)
        .where(and(eq(alertRules.id, id), eq(alertRules.tenantId, tenantId)))
        .returning(),
    );
    return row ? toRuleDTO(row) : null;
  } catch (e) {
    if (isUniqueViolation(e)) return "duplicate";
    throw e;
  }
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
  attempts: number;
  nextAttemptAt: string | null;
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
    attempts: r.evt.attempts,
    nextAttemptAt: r.evt.nextAttemptAt?.toISOString() ?? null,
    firedAt: r.evt.firedAt.toISOString(),
  }));
}
