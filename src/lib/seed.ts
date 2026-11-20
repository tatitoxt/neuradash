import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { hashPassword, DEFAULT_SCRYPT } from "@/lib/auth/password";
import { apiKeyDisplayPrefix, sha256Hex } from "@/lib/auth/tokens";
import * as schema from "@/lib/db/schema";

/** Fabricated demo data. Keys and passwords below are for local demos only. */
export const DEMO_PASSWORD = "neuradash-demo";
export const DEMO_TENANTS = [
  {
    slug: "acme",
    name: "Acme Robotics",
    apiKey: "nd_demo_acme_local_only_0000000000000000",
    errorRate: 0.03,
    users: [
      { email: "admin@acme.test", name: "Ada Admin", role: "admin" },
      { email: "viewer@acme.test", name: "Victor Viewer", role: "viewer" },
    ],
  },
  {
    slug: "globex",
    name: "Globex Labs",
    apiKey: "nd_demo_globex_local_only_00000000000000",
    errorRate: 0.08,
    users: [{ email: "admin@globex.test", name: "Grace Globex", role: "admin" }],
  },
] as const;

export const EVENT_SOURCES = ["web", "ios", "android", "api-gateway", "billing"] as const;

/** Deterministic PRNG (mulberry32) so seeded dashboards look the same on every machine. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SyntheticEvent = {
  type: string;
  source: string;
  value: number | null;
  properties: Record<string, unknown>;
};

export function syntheticEvent(rand: () => number, errorRate: number): SyntheticEvent {
  const source = EVENT_SOURCES[Math.floor(rand() * EVENT_SOURCES.length)]!;
  const r = rand();
  if (r < errorRate) {
    const codes = ["E_TIMEOUT", "E_UPSTREAM_502", "E_VALIDATION", "E_RATE_LIMITED"];
    return { type: "error", source, value: null, properties: { code: codes[Math.floor(rand() * codes.length)] } };
  }
  if (r < errorRate + 0.05) {
    return { type: "purchase", source: "billing", value: Math.round((5 + rand() * 195) * 100) / 100, properties: { currency: "USD" } };
  }
  if (r < errorRate + 0.1) return { type: "signup", source, value: null, properties: {} };
  if (r < errorRate + 0.35) {
    return { type: "api_call", source: "api-gateway", value: Math.round(20 + rand() * rand() * 900), properties: { unit: "ms" } };
  }
  const paths = ["/", "/pricing", "/docs", "/dashboard", "/settings"];
  return { type: "page_view", source, value: null, properties: { path: paths[Math.floor(rand() * paths.length)] } };
}

export type SeedOptions = {
  /** Events per tenant spread over the last 7 days. */
  eventsPerTenant?: number;
  now?: Date;
  scrypt?: { N: number; r: number; p: number };
};

/** Truncates all data and inserts demo tenants, users, memberships, API keys and events. Owner connection required. */
export async function seedDemo(owner: pg.Pool | pg.Client, opts: SeedOptions = {}) {
  const db = drizzle(owner, { schema });
  const now = opts.now ?? new Date();
  const eventsPerTenant = opts.eventsPerTenant ?? 6000;
  const passwordHash = await hashPassword(DEMO_PASSWORD, opts.scrypt ?? DEFAULT_SCRYPT);

  await db.execute(sql`truncate events, api_keys, sessions, memberships, users, tenants restart identity cascade`);

  const result: Record<string, { tenantId: string; apiKey: string }> = {};
  for (const [index, t] of DEMO_TENANTS.entries()) {
    const [tenant] = await db.insert(schema.tenants).values({ slug: t.slug, name: t.name }).returning();
    for (const u of t.users) {
      const [user] = await db.insert(schema.users).values({ email: u.email, name: u.name, passwordHash }).returning();
      await db.insert(schema.memberships).values({ tenantId: tenant!.id, userId: user!.id, role: u.role });
    }
    await db.insert(schema.apiKeys).values({
      tenantId: tenant!.id,
      name: "Demo generator",
      prefix: apiKeyDisplayPrefix(t.apiKey),
      keyHash: sha256Hex(t.apiKey),
    });

    const rand = mulberry32(1000 + index);
    const span = 7 * 24 * 60 * 60_000;
    const rows = [];
    for (let i = 0; i < eventsPerTenant; i++) {
      // Daily traffic curve: more events during the (UTC) afternoon.
      let offset = rand() * span;
      const hour = new Date(now.getTime() - offset).getUTCHours();
      if (rand() > 0.35 + 0.65 * Math.sin((Math.PI * hour) / 24)) offset = rand() * span;
      rows.push({ ...syntheticEvent(rand, t.errorRate), tenantId: tenant!.id, occurredAt: new Date(now.getTime() - offset) });
    }
    for (let i = 0; i < rows.length; i += 1000) {
      await db.insert(schema.events).values(rows.slice(i, i + 1000));
    }
    result[t.slug] = { tenantId: tenant!.id, apiKey: t.apiKey };
  }
  return result;
}
