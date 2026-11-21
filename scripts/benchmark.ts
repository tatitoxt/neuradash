/** Ingest + metrics-query benchmark against a real Postgres.
 *
 * Usage:
 *   DATABASE_URL=postgres://app@host/db DATABASE_OWNER_URL=postgres://owner@host/db \
 *     npx tsx scripts/benchmark.ts [--events 20000] [--batch 500] [--json]
 *
 * Measures:
 *   - sustained ingest throughput through `insertEvents` (the same code path
 *     the /api/ingest route uses, incl. rollup maintenance + pg_notify)
 *   - /api/metrics-equivalent query latency via `getMetrics` (rollup path)
 *   - the same aggregation run directly against the raw events table, i.e.
 *     the pre-rollup query shape, so the rollup speedup is measurable
 */

import pg from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/lib/db/schema";
import { insertEvents } from "@/lib/data/events";
import { getMetrics } from "@/lib/data/metrics";
import { closeDb } from "@/lib/db/client";
import type { IngestEvent } from "@/lib/ingest/schema";
import type { RangeKey } from "@/lib/range";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const TOTAL = Number(arg("events", "20000"));
const BATCH = Number(arg("batch", "500"));
const JSON_OUT = process.argv.includes("--json");

const TYPES = ["pageview", "click", "signup", "purchase", "error"];
const SOURCES = ["web", "ios", "android", "api"];

function synthetic(i: number, now: number): IngestEvent {
  const type = TYPES[i % TYPES.length]!;
  return {
    type,
    source: SOURCES[i % SOURCES.length]!,
    value: type === "purchase" ? (i % 250) + 0.99 : null,
    properties: { i },
    // Spread over the last 24h so every range bucket has data.
    occurredAt: new Date(now - ((i * 97) % 86_400_000)),
  };
}

const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function main() {
  const ownerUrl = process.env.DATABASE_OWNER_URL;
  if (!process.env.DATABASE_URL || !ownerUrl) {
    throw new Error("set DATABASE_URL (app role) and DATABASE_OWNER_URL (owner role)");
  }
  const owner = new pg.Pool({ connectionString: ownerUrl });
  const db = drizzle(owner, { schema });
  const slug = `bench-${Date.now().toString(36)}`;

  const [tenant] = await db.insert(schema.tenants).values({ slug, name: "Benchmark" }).returning();
  const tenantId = tenant!.id;
  console.error(`tenant ${slug} (${tenantId})`);

  const now = Date.now();
  const ingestStart = performance.now();
  for (let offset = 0; offset < TOTAL; offset += BATCH) {
    const events = Array.from({ length: Math.min(BATCH, TOTAL - offset) }, (_, i) =>
      synthetic(offset + i, now),
    );
    await insertEvents(tenantId, events);
  }
  const ingestMs = performance.now() - ingestStart;

  const ranges: RangeKey[] = ["1h", "24h", "7d"];
  const rollups: Record<string, number> = {};
  const raw: Record<string, number> = {};
  for (const range of ranges) {
    const samples: number[] = [];
    const rawSamples: number[] = [];
    for (let i = 0; i < 5; i++) {
      let t0 = performance.now();
      await getMetrics(tenantId, range);
      samples.push(performance.now() - t0);
      t0 = performance.now();
      // The pre-rollup query shape: aggregate raw events per bucket.
      await db.execute(sql`
        select date_bin('1 minute', occurred_at, timestamptz 'epoch') as bucket,
               count(*) as events,
               count(*) filter (where type = 'error') as errors,
               coalesce(sum(value) filter (where type = 'purchase'), 0) as revenue
        from events where tenant_id = ${tenantId} group by 1`);
      rawSamples.push(performance.now() - t0);
    }
    rollups[range] = +median(samples).toFixed(1);
    raw[range] = +median(rawSamples).toFixed(1);
  }

  await db.delete(schema.tenants).where(sql`${schema.tenants.id} = ${tenantId}`);
  await owner.end();
  await closeDb();

  const result = {
    events: TOTAL,
    batch: BATCH,
    ingest: {
      ms: Math.round(ingestMs),
      events_per_sec: Math.round((TOTAL / ingestMs) * 1000),
    },
    metrics_query_ms_median: rollups,
    raw_events_query_ms_median: raw,
    rollup_speedup: Object.fromEntries(
      ranges.map((r) => [r, +(raw[r]! / rollups[r]!).toFixed(2)]),
    ),
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nNeuraDash benchmark — ${TOTAL} events, batches of ${BATCH}`);
    console.log(`ingest:  ${result.ingest.events_per_sec} events/sec (${result.ingest.ms} ms total)`);
    for (const r of ranges) {
      console.log(
        `metrics ${r.padEnd(3)}: rollup ${rollups[r]} ms vs raw ${raw[r]} ms ` +
          `(${result.rollup_speedup[r]}x faster)`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
