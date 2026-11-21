ALTER TABLE "api_keys" ADD COLUMN "scopes" text[] DEFAULT '{ingest}' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
-- Scoped, expiring keys: resolve returns the scopes and skips expired keys.
DROP FUNCTION resolve_api_key(text);
CREATE FUNCTION resolve_api_key(p_key_hash text)
  RETURNS TABLE (key_id uuid, tenant_id uuid, scopes text[])
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT k.id, k.tenant_id, k.scopes FROM api_keys k
    WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at > now())
  $$;
