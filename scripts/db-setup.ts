/**
 * Creates/updates the application login role and applies migrations.
 * Uses DATABASE_OWNER_URL (table owner) and reads the app role credentials from DATABASE_URL.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const APP_ROLE = "neuradash_app";

export async function setupDatabase(ownerUrl: string, appUrl: string): Promise<void> {
  const app = new URL(appUrl);
  const appUser = decodeURIComponent(app.username);
  const appPassword = decodeURIComponent(app.password);
  if (appUser !== APP_ROLE) {
    throw new Error(`DATABASE_URL must connect as "${APP_ROLE}" (got "${appUser}")`);
  }
  if (!appPassword) throw new Error("DATABASE_URL must include a password for the app role");

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const exists = await client.query("select 1 from pg_roles where rolname = $1", [APP_ROLE]);
    const verb = exists.rowCount ? "ALTER" : "CREATE";
    const { rows } = await client.query<{ stmt: string }>(
      `select format('${verb} ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) as stmt`,
      [APP_ROLE, appPassword],
    );
    await client.query(rows[0]!.stmt);
    const grant = await client.query<{ stmt: string }>(
      "select format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text) as stmt",
      [APP_ROLE],
    );
    await client.query(grant.rows[0]!.stmt);

    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  } finally {
    await client.end();
  }
}

async function main() {
  const ownerUrl = process.env.DATABASE_OWNER_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!ownerUrl || !appUrl) throw new Error("DATABASE_OWNER_URL and DATABASE_URL must be set");
  await setupDatabase(ownerUrl, appUrl);
  console.log("database ready: role + migrations applied");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
