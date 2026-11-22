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

**Results (2026-11-22, 200,000 events, batches of 1,000, local Postgres 17)**

| Range | Rollups (median) | Raw events, same range and buckets (median) | Speedup |
|---|---:|---:|---:|
| 1h | 9.6 ms | 68.8 ms | 7.2× |
| 24h | 15.9 ms | 138.1 ms | 8.7× |
| 7d | 11.8 ms | 136.9 ms | 11.6× |

Sustained ingest throughput: **14,078 events/sec**.

An earlier run (2026-11-21) reported 22–30×, but its raw query aggregated
every event of the tenant instead of the requested range; the benchmark now
gives both queries the same range and bucket size, so these figures replace
it.

**Reading the numbers**

- Ingest writes each batch plus its per-minute rollup update and `pg_notify`
  in one transaction — the ~14k events/sec rate already includes that
  bookkeeping.
- Rollup query latency is essentially flat across ranges (O(minutes in
  range)), while the raw-events aggregate grows with row count — at 200k
  events it is already ~7–12× slower, and the gap widens linearly.
- Numbers are machine-dependent; they are a reproducible baseline, not a
  marketing figure.
