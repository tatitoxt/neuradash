-- Application role: not the table owner, no superuser, no BYPASSRLS.
-- scripts/db-setup.ts grants LOGIN and sets its password from DATABASE_URL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neuradash_app') THEN
    CREATE ROLE neuradash_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY memberships_tenant ON memberships
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
-- Lets the login flow list the signed-in user's own memberships before a tenant is chosen.
CREATE POLICY memberships_self ON memberships FOR SELECT
  USING (user_id = app_current_user());
--> statement-breakpoint
CREATE POLICY tenants_visible ON tenants FOR SELECT
  USING (
    id = app_current_tenant()
    OR id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app_current_user())
  );
--> statement-breakpoint
CREATE POLICY api_keys_tenant ON api_keys
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
CREATE POLICY events_tenant ON events
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
-- Ingest authenticates before the tenant is known. This function exposes only
-- (key_id, tenant_id) for an exact, non-revoked key hash.
CREATE FUNCTION resolve_api_key(p_key_hash text)
  RETURNS TABLE (key_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT k.id, k.tenant_id FROM api_keys k
    WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO neuradash_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO neuradash_app;
--> statement-breakpoint
GRANT SELECT ON tenants, users, memberships TO neuradash_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON sessions TO neuradash_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON api_keys TO neuradash_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON events TO neuradash_app;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE events_id_seq TO neuradash_app;
