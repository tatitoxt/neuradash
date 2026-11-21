-- Time-based partitioning for `events`: monthly RANGE partitions on
-- received_at. Retention pruning, rollups and dashboard scans can then target
-- only the months they need, and dropping an old partition is an instant
-- detach instead of a table-wide DELETE. A DEFAULT partition catches rows
-- outside the pre-created range, so inserts never fail on partition absence.
CREATE TABLE "events_new" (
	"id" bigint NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"value" double precision,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_type_len" CHECK (char_length("events_new"."type") between 1 and 64),
	CONSTRAINT "events_source_len" CHECK (char_length("events_new"."source") between 1 and 128),
	CONSTRAINT "events_new_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action,
	PRIMARY KEY ("id", "received_at")
) PARTITION BY RANGE ("received_at");
--> statement-breakpoint
-- One shared sequence keeps the bigserial semantics the old table had.
CREATE SEQUENCE "events_new_id_seq" AS bigint;
--> statement-breakpoint
ALTER TABLE "events_new" ALTER COLUMN "id" SET DEFAULT nextval('events_new_id_seq');
--> statement-breakpoint
ALTER SEQUENCE "events_new_id_seq" OWNED BY "events_new"."id";
--> statement-breakpoint
-- Pre-create monthly partitions for a 4-year window centred on now.
DO $$
DECLARE
  m date;
BEGIN
  FOR m IN
    SELECT generate_series(
      date_trunc('month', now())::date - interval '24 months',
      date_trunc('month', now())::date + interval '23 months',
      interval '1 month')
  LOOP
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF events_new FOR VALUES FROM (%L) TO (%L)',
      'events_' || to_char(m, 'YYYY_MM'), m, m + interval '1 month');
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TABLE "events_default" PARTITION OF "events_new" DEFAULT;
--> statement-breakpoint
-- Move existing rows, then swap names. Rows keep flowing through the
-- functions/app unchanged because the table keeps the name `events`.
INSERT INTO "events_new" SELECT * FROM "events";
--> statement-breakpoint
ALTER TABLE "events" RENAME TO "events_old";
--> statement-breakpoint
ALTER TABLE "events_new" RENAME TO "events";
--> statement-breakpoint
DROP TABLE "events_old";
--> statement-breakpoint
ALTER SEQUENCE "events_new_id_seq" RENAME TO "events_id_seq";
--> statement-breakpoint
CREATE INDEX "events_tenant_occurred_idx" ON "events" USING btree ("tenant_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "events_tenant_id_idx" ON "events" USING btree ("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY events_tenant ON events
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON events TO neuradash_app;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE events_id_seq TO neuradash_app;
--> statement-breakpoint
-- Maintenance helper: ensures monthly partitions exist from the current month
-- through p_months_ahead. Call it periodically (e.g. monthly) so inserts never
-- fall back to the DEFAULT partition. Returns how many were created; safe to
-- re-run. Owner-only: it is not granted to neuradash_app.
CREATE FUNCTION create_event_partitions(p_months_ahead integer DEFAULT 3)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    created integer := 0;
    m date;
    part text;
  BEGIN
    FOR m IN
      SELECT generate_series(
        date_trunc('month', now())::date,
        date_trunc('month', now())::date + make_interval(months => p_months_ahead),
        interval '1 month')
    LOOP
      part := 'events_' || to_char(m, 'YYYY_MM');
      IF to_regclass('public.' || part) IS NULL THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
          part, m, m + interval '1 month');
        created := created + 1;
      END IF;
    END LOOP;
    RETURN created;
  END;
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION create_event_partitions(integer) FROM PUBLIC;
