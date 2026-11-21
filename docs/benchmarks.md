# Benchmarks

Measured against a real Postgres (RLS enabled, `neuradash_app` role) using
`scripts/benchmark.ts`, which exercises the exact code paths of
`POST /api/ingest` (`insertEvents`) and `GET /api/metrics` (`getMetrics`).

**How to reproduce**

```sh
DATABASE_URL=postgres://neuradash_app:...@host/db \
DATABASE_OWNER_URL=postgres://postgres:...@host/db \
npx tsx scripts/benchmark.ts --events 200000 --batch 1000   # --json for raw output
```

**Results (2026-11-21, 200,000 events, batches of 1,000, local Postgres 17)**

| Metric | Value |
|---|---:|
| Sustained ingest throughput | **12,709 events/sec** |
| Metrics query (1h) via rollups | 2.6 ms median |
| Metrics query (24h) via rollups | 3.5 ms median |
| Metrics query (7d) via rollups | 3.2 ms median |
| Same query on raw events (pre-rollup shape) | 69.9–93.3 ms median |
| **Rollup speedup** | **22–30× faster** |

**Reading the numbers**

- Ingest writes each batch plus its per-minute rollup update and `pg_notify`
  in one transaction — the ~12.7k events/sec rate already includes that
  bookkeeping.
- Rollup query latency is essentially flat across ranges (O(minutes in
  range)), while the raw-events aggregate grows with row count — at 200k
  events it is already ~30× slower, and the gap widens linearly.
- Numbers are machine-dependent; they are a reproducible baseline, not a
  marketing figure.
