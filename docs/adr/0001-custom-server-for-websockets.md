# ADR 0001 — Custom Node server for Next.js + WebSockets

**Status:** accepted

## Context

Next.js route handlers cannot hold long-lived WebSocket connections. We need an
authenticated, tenant-scoped live channel next to the App Router pages.

## Decision

Run Next.js through a small custom server (`server.ts`) that owns the HTTP
server, hands normal requests to Next and handles `upgrade` requests on `/ws`
with the `ws` library. Other upgrade requests (e.g. dev HMR) are forwarded to
Next's upgrade handler.

## Consequences

- One process and one port serve pages, APIs and WebSockets; simple to run in compose.
- We lose some managed-hosting options (serverless platforms) that do not support custom servers.
- The WebSocket code does not depend on Next and can be integration-tested with a plain `http.Server`.
