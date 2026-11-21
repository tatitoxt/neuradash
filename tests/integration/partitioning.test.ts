import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { appClient, reseed } from "./helpers";

let seeded: Awaited<ReturnType<typeof reseed>>;
let db: pg.Client; // neuradash_app — same role the app uses
let owner: pg.Client; // superuser, for inspecting which partition rows land in

beforeAll(async () => {
  seeded = await reseed(0);
  db = appClient();
  owner = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await db.connect();
  await owner.connect();
});
afterAll(async () => {
  await db.end();
  await owner.end();
});

async function insertEvent(receivedAt: string): Promise<{ id: string; received_at: Date }> {
  await db.query("begin");
  try {
    await db.query("select set_config('app.tenant_id', $1, true)", [seeded.acme!.tenantId]);
    const { rows } = await db.query(
      `insert into events (tenant_id, type, source, occurred_at, received_at)
       values ($1, 'x', 'partitioning-test', $2, $2) returning id, received_at`,
      [seeded.acme!.tenantId, receivedAt]
    );
    await db.query("commit");
    return rows[0];
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}

async function partitionOf(id: string): Promise<string> {
  const { rows } = await owner.query(
    "select tableoid::regclass::text as part from events where id = $1",
    [id]
  );
  return rows[0]?.part;
}

describe("events table partitioning", () => {
  it("routes inserts into the monthly partition for received_at", async () => {
    const row = await insertEvent("now()");
    const month = row.received_at.toISOString().slice(0, 7).replace("-", "_");
    expect(await partitionOf(row.id)).toBe(`events_${month}`);
  });

  it("routes out-of-range dates into the default partition", async () => {
    const row = await insertEvent("'2035-06-01T00:00:00Z'");
    expect(await partitionOf(row.id)).toBe("events_default");
  });

  it("create_event_partitions is idempotent and extends the pre-created range", async () => {
    await owner.query("select create_event_partitions(30)");
    const { rows: [{ month }] } = await owner.query<{ month: string }>(
      "select to_char(date_trunc('month', now()) + interval '30 months', 'YYYY_MM') as month"
    );
    const { rows } = await owner.query("select to_regclass($1) as part", [`public.events_${month}`]);
    expect(rows[0].part).toBe(`events_${month}`);
    const again = await owner.query("select create_event_partitions(30) as created");
    expect(again.rows[0].created).toBe(0);
  });
});
