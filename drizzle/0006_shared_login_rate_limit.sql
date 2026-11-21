CREATE TABLE "auth_rate_windows" (
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "auth_rate_windows_bucket_window_start_pk" PRIMARY KEY("bucket","window_start")
);
--> statement-breakpoint
-- The counter table is only touched by the SECURITY DEFINER functions below.
ALTER TABLE auth_rate_windows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Shared fixed-window limiter for auth endpoints: an atomic upsert on
-- (bucket, window_start) so concurrent logins across app instances count
-- correctly (unlike the previous in-memory limiter). The window is aligned to
-- wall-clock epochs of p_window_seconds. Returns false once the bucket passed
-- p_limit hits inside the current window. Windows older than 10 windows are
-- swept.
CREATE FUNCTION consume_login_attempt(p_bucket text, p_limit integer, p_window_seconds integer)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH w AS (
      SELECT to_timestamp(
        floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
      ) AS ws
    ),
    sweep AS (
      DELETE FROM auth_rate_windows
      WHERE window_start < now() - make_interval(secs => p_window_seconds * 10)
    ),
    ins AS (
      INSERT INTO auth_rate_windows (bucket, window_start, count)
      SELECT p_bucket, ws, 1 FROM w
      ON CONFLICT (bucket, window_start)
      DO UPDATE SET count = auth_rate_windows.count + 1
      RETURNING count
    )
    SELECT COALESCE((SELECT count <= p_limit FROM ins), false)
  $$;
--> statement-breakpoint
-- Clears the bucket after a successful login so good users are not penalised
-- for earlier typos.
CREATE FUNCTION reset_login_attempts(p_bucket text)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    DELETE FROM auth_rate_windows WHERE bucket = p_bucket;
    SELECT
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION consume_login_attempt(text, integer, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION reset_login_attempts(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION consume_login_attempt(text, integer, integer) TO neuradash_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION reset_login_attempts(text) TO neuradash_app;
