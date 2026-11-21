CREATE TABLE "api_key_rate_windows" (
	"key_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "api_key_rate_windows_key_id_window_start_pk" PRIMARY KEY("key_id","window_start")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "rate_limit_per_minute" integer;--> statement-breakpoint
ALTER TABLE "api_key_rate_windows" ADD CONSTRAINT "api_key_rate_windows_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The counter table is only touched by the SECURITY DEFINER function below.
ALTER TABLE api_key_rate_windows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Atomic per-minute token bucket for ingest: one upsert per call under the key's
-- (key_id, minute) row, so concurrent requests count correctly. Returns false
-- once the count passes the key's rate_limit_per_minute; unlimited keys always
-- pass and no row is written. Windows older than 10 minutes are swept.
CREATE FUNCTION consume_ingest_token(p_key_id uuid)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH k AS (
      SELECT rate_limit_per_minute AS lim FROM api_keys WHERE id = p_key_id
    ),
    sweep AS (
      DELETE FROM api_key_rate_windows
      WHERE window_start < date_trunc('minute', now()) - interval '10 minutes'
    ),
    ins AS (
      INSERT INTO api_key_rate_windows (key_id, window_start, count)
      SELECT p_key_id, date_trunc('minute', now()), 1 FROM k WHERE lim IS NOT NULL
      ON CONFLICT (key_id, window_start)
      DO UPDATE SET count = api_key_rate_windows.count + 1
      RETURNING count
    )
    SELECT CASE
      WHEN (SELECT lim FROM k) IS NULL THEN true
      ELSE COALESCE((SELECT count <= (SELECT lim FROM k) FROM ins), false)
    END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION consume_ingest_token(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION consume_ingest_token(uuid) TO neuradash_app;
