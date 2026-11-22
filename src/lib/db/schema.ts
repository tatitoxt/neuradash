import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("tenant_role", ["admin", "viewer"]);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Event retention window in days; null keeps events forever. */
  retentionDays: integer("retention_days"),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] }), index("memberships_user_idx").on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    scopes: text("scopes").array().notNull().default(sql`'{ingest}'`),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Max ingest requests per rolling minute; null = unlimited. */
    rateLimitPerMinute: integer("rate_limit_per_minute"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("api_keys_tenant_idx").on(t.tenantId)],
);

// Per-minute ingest counters for api_keys.rate_limit_per_minute; read/written
// atomically by the consume_ingest_token() SQL function, never by the app.
export const apiKeyRateWindows = pgTable(
  "api_key_rate_windows",
  {
    keyId: uuid("key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.windowStart] })],
);

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    source: text("source").notNull(),
    value: doublePrecision("value"),
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("events_tenant_occurred_idx").on(t.tenantId, t.occurredAt),
    index("events_tenant_id_idx").on(t.tenantId, t.id),
    check("events_type_len", sql`char_length(${t.type}) between 1 and 64`),
    check("events_source_len", sql`char_length(${t.source}) between 1 and 128`),
  ],
);

export const metricRollups = pgTable(
  "metric_rollups",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    events: bigint("events", { mode: "number" }).notNull().default(0),
    errors: bigint("errors", { mode: "number" }).notNull().default(0),
    revenue: doublePrecision("revenue").notNull().default(0),
    sources: text("sources").array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.bucketStart] })],
);

export type Role = (typeof roleEnum.enumValues)[number];
export type EventRow = typeof events.$inferSelect;

export const alertRules = pgTable(
  "alert_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    metric: text("metric").notNull(),
    op: text("op").notNull(),
    threshold: doublePrecision("threshold").notNull(),
    webhookUrl: text("webhook_url").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    cooldownMinutes: integer("cooldown_minutes").notNull().default(15),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("alert_rules_tenant_name").on(t.tenantId, t.name)],
);

export const alertEvents = pgTable(
  "alert_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => alertRules.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    observed: doublePrecision("observed").notNull(),
    threshold: doublePrecision("threshold").notNull(),
    delivered: boolean("delivered").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("alert_events_tenant_idx").on(t.tenantId, t.firedAt)],
);
