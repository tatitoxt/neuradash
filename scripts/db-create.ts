import pg from "pg";

/** Creates the database named in DATABASE_OWNER_URL if it does not exist yet. */
async function main() {
  const ownerUrl = process.env.DATABASE_OWNER_URL;
  if (!ownerUrl) throw new Error("DATABASE_OWNER_URL must be set");
  const target = new URL(ownerUrl);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  target.pathname = "/postgres";
  const client = new pg.Client({ connectionString: target.toString() });
  await client.connect();
  try {
    const exists = await client.query("select 1 from pg_database where datname = $1", [dbName]);
    if (exists.rowCount) return;
    await client.query(`create database "${dbName.replaceAll('"', '""')}"`);
    console.log(`created database ${dbName}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
