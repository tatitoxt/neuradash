import pg from "pg";
import { setupDatabase } from "../../scripts/db-setup";

/** Creates the test database if needed and applies migrations. Each test file reseeds. */
export default async function globalSetup() {
  const ownerUrl = process.env.TEST_DATABASE_OWNER_URL ?? process.env.DATABASE_OWNER_URL!;
  const appUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!;
  const dbName = new URL(ownerUrl).pathname.slice(1);
  const admin = new URL(ownerUrl);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  const exists = await client.query("select 1 from pg_database where datname = $1", [dbName]);
  if (!exists.rowCount) await client.query(`create database "${dbName.replaceAll('"', '""')}"`);
  await client.end();
  await setupDatabase(ownerUrl, appUrl);
}
