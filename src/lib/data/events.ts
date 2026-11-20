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
