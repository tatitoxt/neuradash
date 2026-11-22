-- One-shot recovery codes for TOTP MFA. Losing the authenticator without a
-- recovery path meant being locked out until another tenant admin re-invited
-- the user. Codes are shown once at enrollment (or regeneration); only their
-- SHA-256 is stored, in a table with no grants — all access goes through
-- SECURITY DEFINER functions, mirroring the user_totp precedent.

CREATE TABLE totp_recovery_codes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hash)
);--> statement-breakpoint

-- Replace the whole set (enrollment confirm and regeneration both rotate
-- every code at once so a stale code can never outlive its set).
CREATE FUNCTION totp_codes_set(p_user_id uuid, p_hashes text[])
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    DELETE FROM totp_recovery_codes WHERE user_id = p_user_id;
    INSERT INTO totp_recovery_codes (user_id, code_hash)
      SELECT p_user_id, h FROM unnest(p_hashes) AS h;
  END
  $$;--> statement-breakpoint

-- Atomically consume a code: DELETE ... RETURNING makes each code one-shot
-- even under concurrent login attempts.
CREATE FUNCTION totp_codes_consume(p_user_id uuid, p_hash text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    ok boolean;
  BEGIN
    DELETE FROM totp_recovery_codes
      WHERE user_id = p_user_id AND code_hash = p_hash
      RETURNING true INTO ok;
    RETURN ok IS NOT NULL;
  END
  $$;--> statement-breakpoint

-- Remaining unused codes, surfaced in /api/me/mfa so users know when to rotate.
CREATE FUNCTION totp_codes_count(p_user_id uuid)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    RETURN (SELECT count(*) FROM totp_recovery_codes WHERE user_id = p_user_id);
  END
  $$;--> statement-breakpoint

-- Disabling MFA now also drops every recovery code.
CREATE OR REPLACE FUNCTION totp_disable(p_user_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    DELETE FROM totp_recovery_codes WHERE user_id = p_user_id;
    DELETE FROM user_totp WHERE user_id = p_user_id;
    RETURN FOUND;
  END
  $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION totp_codes_set(uuid, text[]) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION totp_codes_consume(uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION totp_codes_count(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION totp_codes_set(uuid, text[]) TO neuradash_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION totp_codes_consume(uuid, text) TO neuradash_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION totp_codes_count(uuid) TO neuradash_app;--> statement-breakpoint
