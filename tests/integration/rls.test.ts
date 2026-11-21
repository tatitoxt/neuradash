import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { appClient, reseed } from "./helpers";

let seeded: Awaited<ReturnType<typeof reseed>>;
let db: pg.Client;

async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

beforeAll(async () => {
  seeded = await reseed(40);
  db = appClient();
  await db.connect();
});
afterAll(() => db.end());

describe("Postgres row-level security (app role, no application code involved)", () => {
  it("connects as a role that cannot bypass RLS", async () => {
    const { rows } = await db.query("select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user");
    expect(rows[0]).toEqual({ current_user: "neuradash_app", rolsuper: false, rolbypassrls: false });
  });

  it("sees nothing when no tenant context is set", async () => {
    for (const table of ["tenants", "memberships", "api_keys", "events"]) {
      const { rows } = await db.query(`select count(*)::int as n from ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
  });

  it("sees only the current tenant's rows even without a WHERE clause", async () => {
    const acme = seeded.acme!.tenantId;
    const globex = seeded.globex!.tenantId;
    await asTenant(acme, async () => {
      const events = await db.query("select distinct tenant_id from events");
      expect(events.rows).toEqual([{ tenant_id: acme }]);
      const byId = await db.query("select count(*)::int as n from events where tenant_id = $1", [globex]);
      expect(byId.rows[0].n).toBe(0);
      const tenants = await db.query("select slug from tenants");
      expect(tenants.rows).toEqual([{ slug: "acme" }]);
      const keys = await db.query("select count(*)::int as n from api_keys");
      expect(keys.rows[0].n).toBe(1);
    });
  });

  it("rejects writes into another tenant", async () => {
    const acme = seeded.acme!.tenantId;
    const globex = seeded.globex!.tenantId;
    await expect(
      asTenant(acme, () => db.query("insert into events (tenant_id, type, source) values ($1, 'x', 'test')", [globex])),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot move a row to another tenant, nor update or delete events at all", async () => {
    const acme = seeded.acme!.tenantId;
    const globex = seeded.globex!.tenantId;
    await expect(asTenant(acme, () => db.query("update api_keys set tenant_id = $1", [globex]))).rejects.toThrow(
      /row-level security|permission denied/,
    );
    await expect(asTenant(acme, () => db.query("delete from events"))).rejects.toThrow(/permission denied/);
  });

  it("cannot modify identities or tenants, nor disable RLS", async () => {
    await expect(db.query("update users set password_hash = 'x'")).rejects.toThrow(/permission denied/);
    await expect(db.query("insert into tenants (slug, name) values ('evil', 'Evil')")).rejects.toThrow(/permission denied/);
    // Member admin is granted now, but writes still cannot escape the tenant context:
    // with no app.tenant_id set, the RLS WITH CHECK rejects the row.
    const { rows: anyUser } = await db.query("select id from users limit 1");
    await expect(
      db.query("insert into memberships (tenant_id, user_id, role) values ($1, $2, 'admin')", [
        seeded.acme!.tenantId,
        anyUser[0].id,
      ]),
    ).rejects.toThrow(/row-level security/);
    await expect(db.query("alter table events disable row level security")).rejects.toThrow(/must be owner/);
  });

  it("resolves an API key to its tenant only through the SECURITY DEFINER function", async () => {
    const { rows } = await db.query(
      "select tenant_id from resolve_api_key(encode(sha256(convert_to($1, 'UTF8')), 'hex'))",
      [seeded.globex!.apiKey],
    );
    expect(rows).toEqual([{ tenant_id: seeded.globex!.tenantId }]);
    const none = await db.query("select * from resolve_api_key('nope')");
    expect(none.rowCount).toBe(0);
  });
});

describe("metric_rollups (pre-aggregated per-minute metrics)", () => {
  it("is populated by the seed at 1-minute granularity", async () => {
    await asTenant(seeded.acme!.tenantId, async () => {
      const { rows } = await db.query(
        "select count(*)::int as buckets, sum(events)::int as total from metric_rollups",
      );
      expect(rows[0].buckets).toBeGreaterThan(0);
      expect(rows[0].total).toBe(40); // reseed(40) events in acme
    });
  });

  it("sees nothing without tenant context and only own rows with it", async () => {
    const { rows } = await db.query("select count(*)::int as n from metric_rollups");
    expect(rows[0].n).toBe(0);
    await asTenant(seeded.acme!.tenantId, async () => {
      const tenants = await db.query("select distinct tenant_id from metric_rollups");
      expect(tenants.rows).toEqual([{ tenant_id: seeded.acme!.tenantId }]);
    });
  });
});
