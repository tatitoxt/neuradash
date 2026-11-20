# ADR 0003 — Tenant isolation in the data layer and with Row-Level Security

**Status:** accepted

## Context

A single missing `WHERE tenant_id = ...` is the classic multi-tenant data leak.

## Decision

- Tenant-owned tables (`tenants`, `memberships`, `api_keys`, `events`) have RLS
  enabled. Policies compare `tenant_id` with `current_setting('app.tenant_id', true)`.
- The app connects as `neuradash_app`, which is not the table owner, not a
  superuser and has no `BYPASSRLS`. Migrations and seeding use the owner role.
- All tenant-scoped data access goes through `withTenant(tenantId, fn)`, which
  opens a transaction and sets `app.tenant_id` with `set_config(..., true)` so the
  value cannot leak to the next pooled connection user.
- Queries still filter by `tenant_id` explicitly; RLS is the backstop.
- Two lookups happen before a tenant is known: API-key resolution uses a
  `SECURITY DEFINER` function that returns only `(key_id, tenant_id)` for a hash,
  and login reads the user's own memberships through a policy on `app.user_id`.
- `users` and `sessions` are global identity tables without RLS.

## Consequences

- Integration tests can prove that the app role cannot read or write other
  tenants' rows even with hand-written SQL.
- Every tenant query pays for one extra round trip (`set_config`) per transaction.
