-- Hardening from the PR #1 review (see the PR's Devin Review triage).

-- 0002 dropped and recreated resolve_api_key, which restored PostgreSQL's
-- default PUBLIC EXECUTE grant. Re-apply the grants from 0001.
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO neuradash_app;--> statement-breakpoint

-- 0008 copied existing rows into a table with a fresh sequence; move the
-- sequence past the copied ids so new events never reuse one.
SELECT setval('events_id_seq', (SELECT max(id) FROM events))
  WHERE (SELECT max(id) FROM events) > (SELECT last_value FROM events_id_seq);--> statement-breakpoint

-- Restarting enrollment must not silently disable a confirmed factor: that
-- would let a stolen session swap the authenticator without the password.
CREATE OR REPLACE FUNCTION totp_begin(p_user_id uuid, p_secret text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    INSERT INTO user_totp (user_id, secret, enabled, enabled_at)
      VALUES (p_user_id, p_secret, false, NULL)
      ON CONFLICT (user_id)
      DO UPDATE SET secret = EXCLUDED.secret, enabled = false, enabled_at = NULL
      WHERE user_totp.enabled = false;
  END
  $$;--> statement-breakpoint

-- Serialize rotations per user so two concurrent regenerations cannot both
-- survive (the second DELETE would miss rows the first had not committed).
CREATE OR REPLACE FUNCTION totp_codes_set(p_user_id uuid, p_hashes text[])
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('totp_codes:' || p_user_id::text, 0));
    DELETE FROM totp_recovery_codes WHERE user_id = p_user_id;
    INSERT INTO totp_recovery_codes (user_id, code_hash)
      SELECT p_user_id, h FROM unnest(p_hashes) AS h;
  END
  $$;--> statement-breakpoint

-- TOTP replay protection: remember the last accepted time step and only
-- accept strictly newer ones.
ALTER TABLE user_totp ADD COLUMN last_step bigint;--> statement-breakpoint
CREATE FUNCTION totp_use_step(p_user_id uuid, p_step bigint)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    UPDATE user_totp SET last_step = p_step
      WHERE user_id = p_user_id AND enabled AND (last_step IS NULL OR last_step < p_step);
    RETURN FOUND;
  END
  $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION totp_use_step(uuid, bigint) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION totp_use_step(uuid, bigint) TO neuradash_app;--> statement-breakpoint

-- Compare-and-swap password rotation: only succeeds if the hash the caller
-- verified is still current, so overlapping changes cannot both win.
CREATE FUNCTION change_user_password(p_user_id uuid, p_expected_hash text, p_password_hash text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    UPDATE users SET password_hash = p_password_hash
      WHERE id = p_user_id AND password_hash = p_expected_hash;
    RETURN FOUND;
  END
  $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION change_user_password(uuid, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION change_user_password(uuid, text, text) TO neuradash_app;--> statement-breakpoint

-- Snapshot the operator with the alert event so retries describe the
-- condition that actually fired, even if the rule is edited later.
ALTER TABLE alert_events ADD COLUMN op text;--> statement-breakpoint
UPDATE alert_events e SET op = r.op FROM alert_rules r WHERE r.id = e.rule_id;
