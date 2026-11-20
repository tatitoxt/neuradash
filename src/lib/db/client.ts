import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type Globals = { __neuradashPool?: pg.Pool; __neuradashDb?: Db };
const globals = globalThis as unknown as Globals;

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  return url;
}

/** Pool connected as the RLS-restricted application role. Reused across hot reloads. */
export function getPool(): pg.Pool {
  if (!globals.__neuradashPool) {
    globals.__neuradashPool = new pg.Pool({
      connectionString: databaseUrl(),
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    });
  }
  return globals.__neuradashPool;
}

export function getDb(): Db {
  if (!globals.__neuradashDb) {
    globals.__neuradashDb = drizzle(getPool(), { schema });
  }
  return globals.__neuradashDb;
}

export async function closeDb(): Promise<void> {
  const pool = globals.__neuradashPool;
  globals.__neuradashPool = undefined;
  globals.__neuradashDb = undefined;
  await pool?.end();
}

/**
 * Runs `fn` in a transaction where Postgres RLS policies only expose rows of `tenantId`.
 * `set_config(..., true)` is transaction-local, so the setting never leaks to the next
 * user of the pooled connection.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/** Runs `fn` with only the user's own memberships (and their tenants) visible. */
export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
