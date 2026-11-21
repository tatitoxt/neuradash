-- Per-tenant event retention: events older than retention_days are pruned;
-- metric_rollups already hold the aggregates so dashboards are unaffected.
ALTER TABLE "tenants" ADD COLUMN "retention_days" integer;
--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_retention_days_check"
  CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650);
--> statement-breakpoint
-- Admin-only entry point (route guards the role): sets the current tenant's
-- retention window; NULL keeps events forever. Enforced inside the function
-- because neuradash_app has no UPDATE grant on tenants (RLS: select-only).
CREATE FUNCTION set_tenant_retention(p_days integer)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF p_days IS NOT NULL AND (p_days < 1 OR p_days > 3650) THEN
      RAISE EXCEPTION 'retention_days must be between 1 and 3650';
    END IF;
    UPDATE tenants SET retention_days = p_days WHERE id = app_current_tenant();
    RETURN p_days;
  END;
  $$;
--> statement-breakpoint
-- Deletes the current tenant's events past their retention window and returns
-- the deleted count. Safe to call repeatedly; a tenant without retention set
-- loses nothing.
CREATE FUNCTION prune_tenant_events()
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    deleted integer;
  BEGIN
    DELETE FROM events e
      USING tenants t
      WHERE e.tenant_id = t.id
        AND t.id = app_current_tenant()
        AND t.retention_days IS NOT NULL
        AND e.received_at < now() - make_interval(days => t.retention_days);
    GET DIAGNOSTICS deleted = ROW_COUNT;
    RETURN deleted;
  END;
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION set_tenant_retention(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION prune_tenant_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_tenant_retention(integer) TO neuradash_app;
GRANT EXECUTE ON FUNCTION prune_tenant_events() TO neuradash_app;
