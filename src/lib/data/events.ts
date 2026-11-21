import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db/client";
import { events, type EventRow } from "@/lib/db/schema";
import type { IngestEvent } from "@/lib/ingest/schema";
import type { EventDTO } from "@/lib/live/types";

export const EVENTS_CHANNEL = "neuradash_events";
export const BACKFILL_LIMIT = 500;

export function toDTO(row: EventRow): EventDTO {
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    value: row.value,
    properties: row.properties,
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
  };
}

/**
 * Persists events for one tenant and queues a NOTIFY that Postgres delivers after commit.
 * The payload only carries ids; listeners re-read rows under the tenant's RLS context.
 */
export async function insertEvents(tenantId: string, input: IngestEvent[]): Promise<EventDTO[]> {
  return withTenant(tenantId, async (tx) => {
    // Serialize a tenant's writes so its ids become visible in increasing order; otherwise a
    // concurrent insert could commit a lower id after a client resumed past a higher one.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
    const rows = await tx
      .insert(events)
      .values(input.map((e) => ({ ...e, tenantId })))
      .returning();
    // Maintain the per-minute rollup in the same transaction so metrics
    // queries never read the raw events table.
    const byMinute = new Map<number, { events: number; errors: number; revenue: number; sources: Set<string> }>();
    for (const e of input) {
      const bucket = Math.floor(e.occurredAt.getTime() / 60_000) * 60_000;
      const r = byMinute.get(bucket) ?? { events: 0, errors: 0, revenue: 0, sources: new Set() };
      r.events += 1;
      if (e.type === "error") r.errors += 1;
      if (e.type === "purchase" && e.value != null) r.revenue += e.value;
      r.sources.add(e.source);
      byMinute.set(bucket, r);
    }
    for (const [bucket, r] of byMinute) {
      const sourceList = sql.join(
        [...r.sources].map((src) => sql`${src}`),
        sql`, `,
      );
      await tx.execute(sql`
        insert into metric_rollups (tenant_id, bucket_start, events, errors, revenue, sources)
        values (${tenantId}, ${new Date(bucket)}, ${r.events}, ${r.errors}, ${r.revenue},
                array[${sourceList}]::text[])
        on conflict (tenant_id, bucket_start) do update set
          events = metric_rollups.events + excluded.events,
          errors = metric_rollups.errors + excluded.errors,
          revenue = metric_rollups.revenue + excluded.revenue,
          sources = (select array_agg(distinct s) from unnest(metric_rollups.sources || excluded.sources) s)`);
    }
    const payload = JSON.stringify({ tenantId, ids: rows.map((r) => r.id) });
    await tx.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${payload})`);
    return rows.map(toDTO);
  });
}

export async function getEventsByIds(tenantId: string, ids: number[]): Promise<EventDTO[]> {
  if (ids.length === 0) return [];
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(events)
      .where(and(eq(events.tenantId, tenantId), inArray(events.id, ids)))
      .orderBy(events.id),
  );
  return rows.map(toDTO);
}

export async function getEvent(tenantId: string, id: number): Promise<EventDTO | null> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(events)
      .where(and(eq(events.tenantId, tenantId), eq(events.id, id)))
      .limit(1),
  );
  return row ? toDTO(row) : null;
}

/** Newest first; `beforeId` pages backwards. */
export async function listRecentEvents(
  tenantId: string,
  opts: { limit?: number; beforeId?: number } = {},
): Promise<EventDTO[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(events)
      .where(
        and(eq(events.tenantId, tenantId), opts.beforeId ? lt(events.id, opts.beforeId) : undefined),
      )
      .orderBy(desc(events.id))
      .limit(limit),
  );
  return rows.map(toDTO);
}

/** Events after `afterId`, oldest first, for WebSocket resume. */
export async function listEventsAfter(
  tenantId: string,
  afterId: number,
  limit = BACKFILL_LIMIT,
): Promise<{ events: EventDTO[]; truncated: boolean }> {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(events)
      .where(and(eq(events.tenantId, tenantId), gt(events.id, afterId)))
      .orderBy(events.id)
      .limit(limit + 1),
  );
  return { events: rows.slice(0, limit).map(toDTO), truncated: rows.length > limit };
}

export async function latestEventId(tenantId: string): Promise<number> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({ id: sql<string | null>`max(${events.id})` })
      .from(events)
      .where(eq(events.tenantId, tenantId)),
  );
  return row?.id ? Number(row.id) : 0;
}
