import pg from "pg";
import { DEMO_PASSWORD, DEMO_TENANTS, seedDemo } from "@/lib/seed";

async function main() {
  const ownerUrl = process.env.DATABASE_OWNER_URL;
  if (!ownerUrl) throw new Error("DATABASE_OWNER_URL must be set");
  const pool = new pg.Pool({ connectionString: ownerUrl });
  try {
    const existing = await pool.query("select count(*)::int as n from tenants");
    if (existing.rows[0].n > 0 && !process.argv.includes("--reset")) {
      console.log("tenants already present; skipping seed (use --reset to wipe and reseed)");
      return;
    }
    await seedDemo(pool);
    console.log("seeded synthetic demo data:");
    for (const t of DEMO_TENANTS) {
      console.log(`  ${t.name} (${t.slug}) api key: ${t.apiKey}`);
      for (const u of t.users) console.log(`    ${u.role.padEnd(6)} ${u.email} / ${DEMO_PASSWORD}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
