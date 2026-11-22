# NeuraDash

[![CI](https://github.com/tatitoxt/neuradash/actions/workflows/ci.yml/badge.svg)](https://github.com/tatitoxt/neuradash/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Multi-tenant, real-time analytics dashboard: services push events over an authenticated ingest API, and each tenant's dashboard updates live over WebSockets, with tenant isolation enforced both in application queries and by PostgreSQL Row-Level Security.

![NeuraDash dashboard with synthetic data](docs/img/dashboard.png)

> Portfolio project. All tenants, users, events and API keys are **synthetic** and exist only for the local demo.

## Problem

SaaS products that show customers their own usage data have two hard requirements that are easy to get subtly wrong:

1. **Isolation** — one forgotten `WHERE tenant_id = ...` (in SQL, or in a WebSocket broadcast) leaks another customer's data.
2. **Freshness** — dashboards should reflect new events within a second, and must not silently lose events when a browser reconnects.

NeuraDash is a small, complete implementation of that story: ingest → persist → tenant-scoped broadcast → live dashboard, with tests that try to break isolation over SQL, HTTP and WebSocket.

## What it does today

- **Email + password login** with scrypt-hashed passwords and opaque session tokens (only their SHA-256 is stored), sent as `HttpOnly; SameSite=Lax` cookies. Same-origin checks on every cookie-authenticated mutation; per-email login rate limiting shared across instances (counters in Postgres, enforced by an atomic upsert inside `consume_login_attempt`).
- **Roles per tenant**: `admin` and `viewer`, re-read from the database on every request. Viewers get HTTP 403 on admin APIs and a 403 page on `/admin`.
- **Ingest API**: `POST /api/ingest` with a per-tenant API key (`Authorization: Bearer …`), single event or batch of up to 100, validated with Zod. The tenant comes from the key only; a `tenantId` field in the body is rejected. Keys carry scopes (`ingest`, `read`) and an optional expiry, enforced inside `resolve_api_key` in the database — revoked and expired keys resolve to nothing, and a key without the `ingest` scope gets 403. Keys with the `read` scope call `GET /api/metrics` and `GET /api/events` without a session. An optional per-key `rateLimitPerMinute` is enforced by `consume_ingest_token`, an atomic upsert on `(key_id, minute)` — over-limit ingest gets 429 while other keys are unaffected.
- **Pre-aggregated metrics** (7–12× faster queries than an equal-range raw aggregation — measured in [docs/benchmarks.md](docs/benchmarks.md)): ingest maintains `metric_rollups` (per-tenant, per-minute counts, errors, revenue, sources) inside the same transaction, so the dashboard's `/api/metrics` reads O(minutes) rows instead of scanning raw events.
- **Time-partitioned events**: `events` is a RANGE-partitioned table on
  `received_at` (49 monthly partitions + a DEFAULT catch-all). Retention
  pruning and dashboard scans hit only the months they need, and
  `create_event_partitions(n)` (SECURITY DEFINER, owner-only) keeps a
  rolling window ahead of time.
- **Per-tenant event retention**: admins set a 1–3650-day window
  (`PUT /api/admin/retention`, SECURITY DEFINER — the app role stays
  read-only on `tenants`) and prune on demand or from cron
  (`POST /api/admin/retention/prune`, `prune_tenant_events()`); pruned raw
  events leave `metric_rollups` aggregates untouched, so dashboards survive.
- **Persistence + broadcast**: events are inserted in Postgres and announced with `pg_notify` (IDs only). The WebSocket server re-reads them under the owning tenant's RLS context and sends them only to sockets of that tenant.
- **Authenticated WebSocket** at `/ws`: requires a valid session cookie and same-origin `Origin`; the channel is the session's tenant (query parameters are ignored). Sockets are closed at the next heartbeat (30 s) after logout or session expiry.
- **Reconnect + backfill**: the browser reconnects with jittered exponential backoff and sends `resume { lastEventId }`; the server replies with the missed events (capped at 500, after which the client resyncs aggregates).
- **Dashboard**: KPI cards (events, error rate, revenue, active sources), event-volume and revenue charts (Recharts), live event feed and a 15m / 1h / 24h / 7d range filter.
- **Tenant switcher**: `/api/me` lists every membership; a header dropdown (visible with 2+ tenants) calls `POST /api/auth/switch-tenant` to re-point the session at another tenant — role is re-resolved per request, so switching from an admin tenant to a viewer tenant drops admin rights immediately.
- **Threshold alerts** (admin only): `GET/POST /api/admin/alerts`,
  `PATCH/DELETE /api/admin/alerts/{id}` manage rules over the rollup metrics —
  `events`, `errors`, `revenue` or `error_rate` (errors/events %) — compared
  with `>`, `>=`, `<` or `<=` against a threshold. Rules are evaluated inside
  the ingest transaction against the minute rollups just written, so firing is
  atomic with the data that triggered it. A firing rule records an
  `alert_events` row (returned by `GET /api/admin/alerts` under `recent`),
  updates `last_fired_at` for cooldown (`cooldownMinutes`, default 15), and —
  after commit — POSTs a JSON payload to its `webhookUrl` with a 3 s timeout;
  delivery success is marked on the event, and webhook failures never affect
  ingest. Webhooks are refused when the host resolves to a loopback, private,
  link-local (e.g. cloud metadata) or reserved address, and redirects are not
  followed; set `ALERT_WEBHOOK_ALLOW_PRIVATE=true` only for local testing.
- **Self-service password change**: `POST /api/me/password` (session + same-origin) verifies the current password, rotates the hash through a SECURITY DEFINER function (the app role cannot UPDATE `users`), and revokes every other session. UI at `/account`, linked from the email in the header.
- **TOTP MFA**: optional per-user second factor (RFC 6238, SHA-1/6 digits/30 s, ±1 window, timing-safe compare — no external dependency). Enrollment (`POST /api/me/mfa`, then `/api/me/mfa/confirm` with a live code) and disabling (`DELETE /api/me/mfa` re-asks the password) live at `/account`; all TOTP reads/writes go through SECURITY DEFINER functions so the app role never touches secret material directly. When enabled, a correct password returns `{ mfaRequired, challenge }` instead of a session — the one-shot challenge (SHA-256'd in `mfa_challenges`, 5-minute expiry, 5-attempt cap enforced atomically) is consumed by `POST /api/auth/mfa` with the authenticator code, which mints the cookie. Enrollment issues 8 one-shot **recovery codes** (`xxxx-xxxx`, SHA-256'd, consumed atomically) accepted in place of the TOTP code; each TOTP time step is accepted once per user (no replay), and enrollment cannot restart while MFA is enabled — it must be disabled with the password first; `POST /api/me/mfa/codes` rotates the whole set and `/api/me/mfa` reports how many remain.
- **Member administration** (admin only): `GET/POST /api/admin/members` lists members and invites by email — a new account is created with a temporary password shown once (no mailer). An email that already has an account is refused with `409 email_in_use`: without email verification the inviter cannot know who controls that account (another tenant's admin may have created it and kept its temporary password), so invites never attach existing accounts. Accounts in several tenants (e.g. `multi@demo.test`) are provisioned by the seed. `PATCH/DELETE /api/admin/members/{id}` change roles or remove members (sessions in that tenant are killed); admins cannot change or remove themselves.
- **Admin page**: create (shown once, with optional 30/90/365-day expiry and a per-minute ingest limit) and revoke ingest API keys; invite members, change roles and remove members.
- **Synthetic data**: deterministic seed (2 tenants, 4 users — `multi@demo.test` belongs to both tenants to demo the switcher — 6,000 events per tenant over 7 days) and a generator that keeps posting events through the public ingest API.
- **`docker compose up`** runs Postgres, migrations + seed, the app and the generator.

## Quickstart (Docker)

Requires Docker with Compose v2.

```bash
git clone https://github.com/tatitoxt/neuradash.git
cd neuradash
docker compose up --build
```

Open http://localhost:3000 and sign in with one of the demo accounts (password `neuradash-demo` for all):

| Email               | Tenant        | Role   |
| ------------------- | ------------- | ------ |
| `admin@acme.test`   | Acme Robotics | admin  |
| `viewer@acme.test`  | Acme Robotics | viewer |
| `admin@globex.test` | Globex Labs   | admin  |
| `multi@demo.test`   | Acme Robotics / Globex Labs | admin / viewer (tenant switcher demo) |

The `generator` service posts about one synthetic event per second per tenant, so the feed moves on its own. To push your own event and watch it appear on the Acme dashboard:

```bash
curl -X POST http://localhost:3000/api/ingest \
  -H "Authorization: Bearer nd_demo_acme_local_only_0000000000000000" \
  -H "Content-Type: application/json" \
  -d '{"type":"purchase","source":"curl","value":42}'
```

Sign in as `admin@globex.test` in another browser profile: that event never shows up there.

Stop with `docker compose down` (add `-v` to drop the database volume).

## Local development

Requires Node.js 22+ and PostgreSQL (tested with 17) reachable as a superuser; the first command starts one in Docker.

```bash
docker run -d --name neuradash-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=neuradash -p 5432:5432 postgres:17-alpine
cp .env.example .env
npm ci
set -a && . ./.env && set +a
npm run db:setup          # creates the restricted app role and applies migrations
npm run db:seed           # synthetic tenants, users, keys and events (--reset to wipe)
npm run dev               # http://localhost:3000
npm run generate:events   # optional, in another shell
```

`DATABASE_OWNER_URL` (table owner) is only used by `db:setup` and `db:seed`. The app itself connects with `DATABASE_URL` as `neuradash_app`, a role without `SUPERUSER` or `BYPASSRLS`.

## Architecture

```mermaid
flowchart LR
  subgraph Producers
    G[Synthetic generator]
    C[Any HTTP client]
  end
  subgraph Server["Node process (server.ts)"]
    N[Next.js App Router<br/>pages + route handlers]
    WS[WebSocket server /ws<br/>session auth, tenant rooms]
  end
  subgraph PG["PostgreSQL"]
    T[(events, api_keys,<br/>memberships, tenants<br/>RLS by app.tenant_id)]
    L{{LISTEN/NOTIFY<br/>neuradash_events}}
  end
  B[Browser dashboard]

  G -- "POST /api/ingest<br/>Bearer api key" --> N
  C -- "POST /api/ingest" --> N
  N -- "resolve_api_key() → tenant<br/>INSERT under tenant RLS" --> T
  T -- "pg_notify {tenantId, ids}" --> L
  L --> WS
  WS -- "re-read ids under tenant RLS" --> T
  WS -- "event (same tenant only)" --> B
  B -- "resume {lastEventId}" --> WS
  B -- "session cookie: pages, /api/metrics, /api/events" --> N
```

- **One process**: `server.ts` wraps Next.js and handles WebSocket upgrades on `/ws` ([ADR 0001](docs/adr/0001-custom-server-for-websockets.md)).
- **Fan-out through Postgres** `LISTEN/NOTIFY`, carrying only event IDs; the listener re-reads rows under RLS ([ADR 0002](docs/adr/0002-postgres-listen-notify-fanout.md)).
- **Isolation twice**: every query filters by `tenant_id`, and `withTenant()` sets `app.tenant_id` transaction-locally so RLS policies restrict the app role even if a filter is forgotten ([ADR 0003](docs/adr/0003-tenant-isolation-rls.md)).
- Requirements and acceptance scenarios: [docs/spec](docs/spec/README.md).

```text
src/app/            pages (login, dashboard, admin) and API route handlers
src/lib/auth/       password hashing, tokens, sessions
src/lib/data/       tenant-scoped data access (events, metrics, api keys, members)
src/lib/db/         Drizzle schema and the withTenant()/withUser() transaction helpers
src/lib/live/       wire types and the pure dashboard reducer
src/server/         WebSocket fan-out (realtime.ts)
drizzle/            SQL migrations (0001_rls.sql: role, policies, grants)
scripts/            db setup, seed, synthetic generator
tests/unit, tests/integration, e2e/
```

## Tests

| Suite | Command | What it covers | Count |
| --- | --- | --- | --- |
| Unit (Vitest) | `npm test` | password hashing, tokens, ingest validation, range buckets, live reducer, cookies, origin check, rate limiter, reconnect backoff, seed PRNG, TOTP (RFC 6238 vectors), webhook address guard (incl. connect-time DNS check) | 39 |
| Integration (Vitest + real Postgres) | `npm run test:integration` | RLS as the app role with raw SQL; route handlers for login/logout, ingest, events, metrics and admin keys; cross-tenant reads, key revocation, expiry/scopes and per-key rate limits; tenant switching and member admin (invite, role change, removal, self-guards); WebSocket auth, tenant-scoped broadcast, backfill, logout disconnect and cross-instance delivery over `pg_notify` (two independent realtime instances on one database); per-minute `metric_rollups` population, RLS on rollups and rollup-driven metrics; monthly-partition routing (current month, DEFAULT catch-all, `create_event_partitions` idempotency); TOTP MFA (challenge gating, wrong-code attempt cap, challenge consumption, password-gated disable, recovery-code issuance/consume/regeneration and clearing on disable); TOTP replay refusal and no re-enrollment over a live factor; refusal to attach an existing account to another tenant; alert rules, delivery retries, once-per-batch cooldown and private-webhook refusal; 4xx (not 500) for null bodies, malformed ids, empty patches and duplicate renames; hard webhook delivery deadline | 78 |
| E2E (Playwright, Chromium) | `npm run build && npm run test:e2e` | real production server in a browser: login, live update after ingest, backfill after a dropped socket, cross-tenant HTTP and WebSocket denial, viewer denied admin, admin key lifecycle | 12 |

Counts are from running the commands above in this repository; re-run them to reproduce.

Integration tests use the database `neuradash_test` and E2E uses `neuradash_e2e` on `localhost:5432` (user `postgres`/`postgres` by default), both created automatically and reseeded, so they never touch the demo data. Override with `TEST_DATABASE_URL` / `TEST_DATABASE_OWNER_URL` and `E2E_DATABASE_URL` / `E2E_DATABASE_OWNER_URL`.

```bash
docker run -d --name neuradash-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17-alpine
npm ci
npx playwright install chromium
npm run lint && npm run typecheck
npm test
npm run test:integration
npm run build && npm run test:e2e
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs lint, typecheck, unit tests and `npm audit --audit-level=high`, the integration and E2E suites against a Postgres 17 service container, and a `docker compose up` smoke test, on every pull request and push to `main`.

## Limitations

- **Invites cannot add existing accounts.** There is no email verification or invite-acceptance flow, so an email that already has an account cannot be invited into another tenant (this blocks cross-tenant account takeover, but also means one tenant's admin can reserve an email first). Multi-tenant accounts come from the seed; a token-based acceptance flow is on the roadmap.
- **Metric ranges are minute-aligned.** Rollups are per minute, so a range's first and last minute are included or excluded as whole minutes rather than to the second.
- **Multi-instance fan-out verified.** `LISTEN/NOTIFY` delivery across two independent realtime instances is covered by an integration test (each instance listens on its own connection). No soak or load testing has been done beyond the recorded benchmarks.
- **Aggregates come from `metric_rollups`** (per-tenant, per-minute buckets maintained inside the ingest transaction), so `/api/metrics` costs O(minutes) not O(events). `events` is monthly-partitioned on `received_at` with a DEFAULT catch-all.
- **Live chart updates are approximate between resyncs**: live events update KPIs and the current bucket client-side; the dashboard re-fetches exact aggregates every 60 s and after a reconnect.
- **No signup or password reset.** Invites are the only way in: no mailer exists, so the temporary password is shown once to the inviting admin and must be handed over manually. Users can change their own password at `/account` (`POST /api/me/password`), which revokes all other sessions. TOTP MFA is opt-in per user; users who lose their authenticator can sign in with a single-use recovery code instead.
- **`users` and `sessions` are global tables without RLS** (they are needed before a tenant is known); the app role can read `users` and insert new rows for invites, but cannot update or delete them. Membership writes stay tenant-scoped by RLS.
- **API keys carry `ingest` and/or `read` scopes**: `ingest` writes events; `read`
  authorizes `GET /api/metrics` and `GET /api/events` without a session. Admin/member
  management still requires a session.
- **Alert delivery retries with backoff**: a firing is recorded transactionally; the webhook POST happens after commit and, on failure, `next_attempt_at` schedules a retry (30s → 2m → 8m → 32m, max 5 attempts, then dead-lettered). A sweeper in `server.ts` claims due rows `FOR UPDATE SKIP LOCKED` per tenant, so several instances can sweep concurrently without double-delivering.
- **Docker image still ships `tsx` and the prod `node_modules`** (the custom server and db scripts run through it); devDependencies are excluded via the multi-stage build. It is meant for local demos, not production.
- **`npm audit`** reports 4 moderate advisories in `drizzle-kit`'s transitive `@esbuild-kit/*` packages (dev-only migration generator, not used at runtime). There are no high or critical findings; CI fails on high/critical.
- The demo API keys and passwords are intentionally public and for local use only.

## Roadmap

- Token-based invite acceptance (or email verification) so existing accounts can join further tenants safely.
- Signup and password reset once a mailer exists.
- Load and soak testing of multi-instance realtime fan-out.
- Slimmer production image without `tsx`.

## License

[MIT](LICENSE) © Fausto Pastura
