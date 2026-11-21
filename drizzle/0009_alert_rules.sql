-- Threshold alert rules evaluated against metric_rollups on every ingest.
-- A rule that fires records an alert_events row and posts a JSON payload to
-- its webhook; cooldown_minutes caps re-fire rate so a noisy metric cannot
-- spam the destination.
CREATE TABLE alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  metric text NOT NULL CHECK (metric IN ('events','errors','revenue','error_rate')),
  op text NOT NULL CHECK (op IN ('>','>=','<','<=')),
  threshold double precision NOT NULL,
  webhook_url text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  cooldown_minutes integer NOT NULL DEFAULT 15 CHECK (cooldown_minutes >= 0),
  last_fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
--> statement-breakpoint
CREATE TABLE alert_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  metric text NOT NULL,
  observed double precision NOT NULL,
  threshold double precision NOT NULL,
  delivered boolean NOT NULL DEFAULT false,
  fired_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX alert_events_tenant_idx ON alert_events (tenant_id, fired_at);
--> statement-breakpoint
ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE alert_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY alert_rules_tenant ON alert_rules
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
CREATE POLICY alert_events_tenant ON alert_events
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON alert_rules TO neuradash_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON alert_events TO neuradash_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE alert_events_id_seq TO neuradash_app;
