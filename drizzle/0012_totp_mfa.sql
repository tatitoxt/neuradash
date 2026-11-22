-- TOTP-based multi-factor authentication (RFC 6238). Secrets live in their
-- own global table so a plain read of `users` never exposes them, and all
-- mutation goes through SECURITY DEFINER functions — mirroring the
-- change_user_password precedent (the app role gets EXECUTE only).
CREATE TABLE user_totp (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  enabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Short-lived challenge between the password step and the TOTP step of
-- sign-in. The app role manipulates rows directly (they are ephemeral);
-- only the hash of the challenge token is stored.
CREATE TABLE mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_slug text NOT NULL DEFAULT '',
  token_hash text NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_challenges TO neuradash_app;--> statement-breakpoint

-- Begin enrollment: store (or replace) a disabled secret for the user.
CREATE FUNCTION totp_begin(p_user_id uuid, p_secret text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    INSERT INTO user_totp (user_id, secret, enabled, enabled_at)
      VALUES (p_user_id, p_secret, false, NULL)
      ON CONFLICT (user_id)
      DO UPDATE SET secret = EXCLUDED.secret, enabled = false, enabled_at = NULL;
  END
  $$;--> statement-breakpoint

-- Read the current enrollment row. Callable by the app role so the login and
-- verify paths can check the secret without a table grant.
CREATE FUNCTION totp_state(p_user_id uuid)
  RETURNS TABLE(secret text, enabled boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    RETURN QUERY SELECT t.secret, t.enabled FROM user_totp t WHERE t.user_id = p_user_id;
  END
  $$;--> statement-breakpoint

-- Mark enrollment confirmed (the caller already verified a valid code).
CREATE FUNCTION totp_enable(p_user_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    UPDATE user_totp SET enabled = true, enabled_at = now() WHERE user_id = p_user_id;
    RETURN FOUND;
  END
  $$;--> statement-breakpoint

-- Disable MFA entirely (row removal also drops a pending enrollment).
CREATE FUNCTION totp_disable(p_user_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    DELETE FROM user_totp WHERE user_id = p_user_id;
    RETURN FOUND;
  END
  $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION totp_begin(uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION totp_state(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION totp_enable(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION totp_disable(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION totp_begin(uuid, text) TO neuradash_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION totp_state(uuid) TO neuradash_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION totp_enable(uuid) TO neuradash_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION totp_disable(uuid) TO neuradash_app;--> statement-breakpoint
