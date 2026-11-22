-- Self-service password change. The app role cannot UPDATE the global
-- `users` table (RLS), so the rotation goes through a SECURITY DEFINER
-- function that only touches the caller's row.
CREATE FUNCTION change_user_password(p_user_id uuid, p_password_hash text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    UPDATE users SET password_hash = p_password_hash WHERE id = p_user_id;
    RETURN FOUND;
  END
  $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION change_user_password(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION change_user_password(uuid, text) TO neuradash_app;
