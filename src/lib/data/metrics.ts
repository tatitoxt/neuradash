import { sql } from "drizzle-orm";
import { withTenant } from "@/lib/db/client";
import type { MetricsDTO, SeriesPoint } from "@/lib/live/types";
import { RANGES, bucketStarts, type RangeKey } from "@/lib/range";

type RollupRow = {
  bucket_start: Date | string;
  events: string | number;
  errors: string | number;
  revenue: number | string | null;
  sources: string[] | null;
};

export async function getMetrics(tenantId: string, range: RangeKey, now = new Date()): Promise<MetricsDTO> {
  const { ms: rangeMs, bucketMs } = RANGES[range];
  const from = new Date(now.getTime() - rangeMs);

  // Metrics read the pre-aggregated per-minute rollups maintained by ingest,
  // so query cost is O(minutes in range), not O(events). The raw table is
  // touched only to pin the live-event snapshot id.
  const [lastEventId, rollupRows] = await withTenant(tenantId, async (tx) => {
    const max = await tx.execute<{ id: string | null }>(
      sql`select max(id) as id from events where tenant_id = ${tenantId}`,
    );
    const maxId = Number(max.rows[0]?.id ?? 0);
    const rows = await tx.execute<RollupRow>(sql`
      select bucket_start, events, errors, revenue, sources
      from metric_rollups
      where tenant_id = ${tenantId} and bucket_start >= ${from} and bucket_start <= ${now}
      order by bucket_start`);
    return [maxId, rows.rows] as const;
  });

  const byBucket = new Map<number, SeriesPoint>();
  const sources = new Set<string>();
  let totalEvents = 0;
  let totalErrors = 0;
  let totalRevenue = 0;
  for (const r of rollupRows) {
    const minute = new Date(r.bucket_start).getTime();
    const t = Math.floor(minute / bucketMs) * bucketMs;
    const agg = byBucket.get(t) ?? { t, events: 0, errors: 0, revenue: 0 };
    agg.events += Number(r.events);
    agg.errors += Number(r.errors);
    agg.revenue += Number(r.revenue ?? 0);
    byBucket.set(t, agg);
    totalEvents += Number(r.events);
    totalErrors += Number(r.errors);
    totalRevenue += Number(r.revenue ?? 0);
    for (const src of r.sources ?? []) sources.add(src);
  }
  const series = bucketStarts(now.getTime(), rangeMs, bucketMs).map(
    (t) => byBucket.get(t) ?? { t, events: 0, errors: 0, revenue: 0 },
  );
  const sourceNames = [...sources].sort();
  return {
    range,
    rangeMs,
    bucketMs,
    generatedAt: now.toISOString(),
    lastEventId,
    summary: {
      events: totalEvents,
      errors: totalErrors,
      revenue: totalRevenue,
      sources: sourceNames.length,
    },
    series,
    sourceNames,
  };
}
