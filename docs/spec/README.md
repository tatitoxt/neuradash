# NeuraDash — product spec

## Problem

Small SaaS teams want a live view of their product telemetry (signups, purchases,
errors, API calls) without standing up a full observability stack. When several
customers (tenants) share one deployment, the hard part is not the charts but the
guarantee that tenant A can never see tenant B's data — over HTTP, over the live
WebSocket channel, or through a bug in a single query.

## Personas

- **Tenant admin** — manages ingest API keys for their workspace and watches the dashboard.
- **Tenant viewer** — read-only access to the dashboard of their workspace.
- **Integrator** — a backend service that pushes events with a tenant API key.

## Requirements

| ID | Requirement |
|----|-------------|
| R1 | Users sign in with email + password. Passwords are stored as salted scrypt hashes; sessions are opaque random tokens stored hashed in Postgres and sent as `HttpOnly` cookies. |
| R2 | Each session is bound to one tenant; the user's role in that tenant (`admin` or `viewer`) is re-read from the database on every request. |
| R3 | `POST /api/ingest` accepts one event or a batch (≤ 100) authenticated by a per-tenant API key. The tenant is derived from the key, never from the request body. |
| R4 | Ingested events are persisted and broadcast to every WebSocket connected to the same tenant, and only to those. |
| R5 | The WebSocket requires a valid session cookie and a same-origin `Origin` header. Clients resume with `lastEventId` and receive missed events (backfill). |
| R6 | The dashboard shows KPI cards, time-series charts and a live event feed for a selectable time range (15m, 1h, 24h, 7d), updating live. |
| R7 | Tenant isolation is enforced twice: every query filters by `tenant_id`, and Postgres Row-Level Security policies restrict the application role to the tenant set in the transaction. |
| R8 | Admins can create and revoke API keys. Viewers cannot see or call admin actions (HTTP 403). |
| R9 | `docker compose up` starts Postgres, runs migrations + synthetic seed and serves the app. |

## Acceptance scenarios

- **Login** — Given a seeded user, when they submit valid credentials, then they land on `/dashboard`; with a wrong password they see an error and no cookie is set.
- **Live update** — Given an admin on the dashboard, when an event is posted to `/api/ingest` with the tenant's key, then it appears in the live feed and the KPI counter increases without reloading.
- **Cross-tenant HTTP** — Given a user of tenant B, when they request an event id that belongs to tenant A, then they get 404; tenant A's events never appear in tenant B's lists or metrics.
- **Cross-tenant WebSocket** — Given sockets for tenants A and B, when an event is ingested for A, then only A's socket receives it.
- **RLS backstop** — Given the application database role, when a query runs without the tenant setting (or with tenant A's), then rows of other tenants are invisible and inserts into another tenant are rejected.
- **Viewer restrictions** — Given a viewer, when they open `/admin` or call `POST /api/admin/api-keys`, then access is denied (403).
- **Reconnect** — Given a socket that disconnected after event N, when it reconnects with `lastEventId = N`, then it receives the events ingested in between.

## Out of scope (for now)

Self-service sign-up, email-based password reset (there is no mailer), SSO,
and horizontal scaling of the WebSocket tier beyond Postgres `LISTEN/NOTIFY`.
Invitations, tenant switching, retention pruning, per-key ingest rate limits,
threshold alerts and TOTP MFA were added later; see the README for their behavior.
