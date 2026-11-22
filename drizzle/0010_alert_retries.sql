-- Alert delivery retries: failed webhook posts are retried with exponential
-- backoff by a background sweeper instead of being marked undelivered after a
-- single attempt. attempts counts deliveries tried; next_attempt_at schedules
-- the next try (NULL = never again: delivered or dead-lettered).
ALTER TABLE alert_events
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN delivered_at timestamptz;
--> statement-breakpoint
UPDATE alert_events SET delivered_at = fired_at, attempts = 1 WHERE delivered;
--> statement-breakpoint
CREATE INDEX alert_events_retry_idx ON alert_events (next_attempt_at)
  WHERE NOT delivered AND next_attempt_at IS NOT NULL;
--> statement-breakpoint
-- Cross-tenant lookup for the sweeper: RLS would hide other tenants' rows, so
-- this runs as the table owner. SELECT-only; the actual claim happens per
-- tenant with FOR UPDATE SKIP LOCKED inside a tenant-scoped transaction.
CREATE FUNCTION tenants_with_due_alert_retries()
  RETURNS SETOF uuid
  LANGUAGE sql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT tenant_id FROM alert_events
    WHERE NOT delivered AND next_attempt_at IS NOT NULL
      AND next_attempt_at <= now()
  $$;
