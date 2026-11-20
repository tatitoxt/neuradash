import { sql } from "drizzle-orm";
import { withTenant } from "@/lib/db/client";
import type { MetricsDTO, SeriesPoint } from "@/lib/live/types";
import { RANGES, bucketStarts, type RangeKey } from "@/lib/range";

type SummaryRow = { events: string; errors: string; revenue: number | null; sources: string[] | null };
type BucketRow = { bucket: Date | string; events: string; errors: string; revenue: number | null };

export async function getMetrics(tenantId: string, range: RangeKey, now = new Date()): Promise<MetricsDTO> {
  const { ms: rangeMs, bucketMs } = RANGES[range];
  const from = new Date(now.getTime() - rangeMs);
  const bucket = `${bucketMs / 1000} seconds`;

  const [lastEventId, summaryRows, bucketRows] = await withTenant(tenantId, async (tx) => {
    // Pin the snapshot to an id so live events can be applied on top without double counting.
    const max = await tx.execute<{ id: string | null }>(
      sql`select max(id) as id from events where tenant_id = ${tenantId}`,
    );
    const maxId = Number(max.rows[0]?.id ?? 0);
    const summary = await tx.execute<SummaryRow>(sql`
      select count(*) as events,
             count(*) filter (where type = 'error') as errors,
             coalesce(sum(value) filter (where type = 'purchase'), 0) as revenue,
             array_agg(distinct source) as sources
      from events
      where tenant_id = ${tenantId} and occurred_at >= ${from} and occurred_at <= ${now} and id <= ${maxId}`);
    const buckets = await tx.execute<BucketRow>(sql`
      select date_bin(${bucket}::interval, occurred_at, timestamptz 'epoch') as bucket,
             count(*) as events,
             count(*) filter (where type = 'error') as errors,
             coalesce(sum(value) filter (where type = 'purchase'), 0) as revenue
      from events
      where tenant_id = ${tenantId} and occurred_at >= ${from} and occurred_at <= ${now} and id <= ${maxId}
      group by 1 order by 1`);
    return [maxId, summary.rows, buckets.rows] as const;
  });

  const byBucket = new Map<number, SeriesPoint>();
  for (const r of bucketRows) {
    const t = new Date(r.bucket).getTime();
    byBucket.set(t, { t, events: Number(r.events), errors: Number(r.errors), revenue: Number(r.revenue ?? 0) });
  }
  const series = bucketStarts(now.getTime(), rangeMs, bucketMs).map(
    (t) => byBucket.get(t) ?? { t, events: 0, errors: 0, revenue: 0 },
  );
  const s = summaryRows[0];
  const sourceNames = (s?.sources ?? []).filter((x): x is string => typeof x === "string");
  return {
    range,
    rangeMs,
    bucketMs,
    generatedAt: now.toISOString(),
    lastEventId,
    summary: {
      events: Number(s?.events ?? 0),
      errors: Number(s?.errors ?? 0),
      revenue: Number(s?.revenue ?? 0),
      sources: sourceNames.length,
    },
    series,
    sourceNames,
  };
}
