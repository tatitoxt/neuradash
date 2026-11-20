# ADR 0002 — Fan out ingested events through Postgres LISTEN/NOTIFY

**Status:** accepted

## Context

The ingest route handler and the WebSocket server live in different module
graphs (Next bundles route handlers separately from the custom server), so an
in-memory event emitter would not be shared reliably. Adding Redis or NATS for a
single-node demo is extra infrastructure.

## Decision

The ingest transaction inserts the events and calls
`pg_notify('neuradash_events', '{"tenantId": ..., "ids": [...]}')`. Notifications
are delivered only after commit. The realtime server keeps one `LISTEN`
connection, re-reads the referenced rows inside a tenant-scoped transaction
(so RLS applies to the WebSocket path too) and sends them to that tenant's sockets.

## Consequences

- No extra broker; multiple app instances could share the same channel.
- NOTIFY payloads are limited to 8 kB, so only ids are sent.
- Events produced while the listener is disconnected are not pushed; clients recover through `lastEventId` backfill.
