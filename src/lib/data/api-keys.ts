import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb, withTenant } from "@/lib/db/client";
import { apiKeys } from "@/lib/db/schema";
import { apiKeyDisplayPrefix, API_KEY_PREFIX, generateApiKey, sha256Hex } from "@/lib/auth/tokens";

export const API_KEY_SCOPES = ["ingest", "read"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type ApiKeyDTO = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  rateLimitPerMinute: number | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

const columns = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  expiresAt: apiKeys.expiresAt,
  rateLimitPerMinute: apiKeys.rateLimitPerMinute,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
};

function toDTO(r: {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: Date | null;
  rateLimitPerMinute: number | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}): ApiKeyDTO {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    rateLimitPerMinute: r.rateLimitPerMinute,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
  };
}

export async function listApiKeys(tenantId: string): Promise<ApiKeyDTO[]> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select(columns).from(apiKeys).where(eq(apiKeys.tenantId, tenantId)).orderBy(desc(apiKeys.createdAt)),
  );
  return rows.map(toDTO);
}

/** Creates a key and returns its plaintext exactly once; only the SHA-256 is stored. */
export async function createApiKey(
  tenantId: string,
  name: string,
  opts: { scopes?: ApiKeyScope[]; expiresAt?: Date | null; rateLimitPerMinute?: number | null; plaintext?: string } = {},
): Promise<{ key: string; apiKey: ApiKeyDTO }> {
  const plaintext = opts.plaintext ?? generateApiKey();
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId,
        name,
        prefix: apiKeyDisplayPrefix(plaintext),
        keyHash: sha256Hex(plaintext),
        scopes: opts.scopes ?? [...API_KEY_SCOPES],
        expiresAt: opts.expiresAt ?? null,
        rateLimitPerMinute: opts.rateLimitPerMinute ?? null,
      })
      .returning(columns),
  );
  return { key: plaintext, apiKey: toDTO(row!) };
}

/** Returns false when the key does not exist in this tenant (or is already revoked). */
export async function revokeApiKey(tenantId: string, id: string): Promise<boolean> {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .update(apiKeys)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id }),
  );
  return rows.length > 0;
}

/**
 * Resolves a plaintext key to its tenant + scopes via the SECURITY DEFINER
 * `resolve_api_key` function. Revoked and expired keys resolve to null.
 */
export async function resolveApiKey(
  plaintext: string,
): Promise<{ keyId: string; tenantId: string; scopes: string[] } | null> {
  if (!plaintext.startsWith(API_KEY_PREFIX) || plaintext.length > 128) return null;
  const result = await getDb().execute<{ key_id: string; tenant_id: string; scopes: string[] }>(
    sql`select key_id, tenant_id, scopes from resolve_api_key(${sha256Hex(plaintext)})`,
  );
  const row = result.rows[0];
  if (!row) return null;
  await withTenant(row.tenant_id, (tx) =>
    tx.update(apiKeys).set({ lastUsedAt: sql`now()` }).where(eq(apiKeys.id, row.key_id)),
  );
  return { keyId: row.key_id, tenantId: row.tenant_id, scopes: row.scopes ?? [] };
}

/**
 * Per-key per-minute ingest limit, enforced inside Postgres by
 * consume_ingest_token(): an atomic upsert on (key_id, minute) so concurrent
 * ingest counts correctly. Keys without a limit always pass.
 */
export async function consumeIngestToken(keyId: string): Promise<boolean> {
  const result = await getDb().execute<{ allowed: boolean }>(
    sql`select consume_ingest_token(${keyId}::uuid) as allowed`,
  );
  return result.rows[0]?.allowed ?? true;
}
