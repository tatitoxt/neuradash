-- Pre-aggregated per-tenant, per-minute metric rollups. Metrics queries then
-- read O(minutes) rows instead of O(events); rollups are updated inside the
-- same transaction as the ingest insert, so they are always consistent.
CREATE TABLE metric_rollups (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bucket_start timestamptz NOT NULL,
  events bigint NOT NULL DEFAULT 0,
  errors bigint NOT NULL DEFAULT 0,
  revenue double precision NOT NULL DEFAULT 0,
  sources text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, bucket_start)
);
--> statement-breakpoint
ALTER TABLE metric_rollups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY metric_rollups_tenant ON metric_rollups
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON metric_rollups TO neuradash_app;
--> statement-breakpoint
-- Backfill existing events at the base 1-minute granularity.
INSERT INTO metric_rollups (tenant_id, bucket_start, events, errors, revenue, sources)
SELECT tenant_id,
       date_bin('1 minute', occurred_at, timestamptz 'epoch'),
       count(*),
       count(*) filter (where type = 'error'),
       coalesce(sum(value) filter (where type = 'purchase'), 0),
       array_agg(distinct source)
FROM events
GROUP BY tenant_id, 2;
