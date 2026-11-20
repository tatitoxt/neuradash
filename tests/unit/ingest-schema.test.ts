import { describe, expect, it } from "vitest";
import { MAX_BATCH, parseIngestBody } from "@/lib/ingest/schema";

const NOW = Date.parse("2026-01-01T12:00:00Z");

describe("parseIngestBody", () => {
  it("accepts a single event and fills defaults", () => {
    const r = parseIngestBody({ type: "signup" }, NOW);
    expect(r).toEqual({
      ok: true,
      events: [{ type: "signup", source: "api", value: null, properties: {}, occurredAt: new Date(NOW) }],
    });
  });

  it("accepts a batch", () => {
    const r = parseIngestBody({ events: [{ type: "a", value: 1 }, { type: "b", source: "web" }] }, NOW);
    expect(r.ok && r.events.map((e) => e.type)).toEqual(["a", "b"]);
  });

  it("rejects a tenant field: the tenant always comes from the API key", () => {
    const r = parseIngestBody({ type: "signup", tenantId: "00000000-0000-0000-0000-000000000000" }, NOW);
    expect(r.ok).toBe(false);
  });

  it("rejects invalid types, oversize batches and oversize properties", () => {
    expect(parseIngestBody({ type: "has spaces" }, NOW).ok).toBe(false);
    expect(parseIngestBody({ type: "" }, NOW).ok).toBe(false);
    expect(parseIngestBody({ events: [] }, NOW).ok).toBe(false);
    expect(parseIngestBody({ events: Array.from({ length: MAX_BATCH + 1 }, () => ({ type: "x" })) }, NOW).ok).toBe(false);
    expect(parseIngestBody({ type: "x", properties: { blob: "a".repeat(3000) } }, NOW).ok).toBe(false);
    expect(parseIngestBody({ type: "x", value: "12" }, NOW).ok).toBe(false);
    expect(parseIngestBody(null, NOW).ok).toBe(false);
  });

  it("rejects timestamps in the future or older than 7 days", () => {
    expect(parseIngestBody({ type: "x", occurredAt: "2026-01-01T13:00:00Z" }, NOW).ok).toBe(false);
    expect(parseIngestBody({ type: "x", occurredAt: "2025-12-20T12:00:00Z" }, NOW).ok).toBe(false);
    expect(parseIngestBody({ type: "x", occurredAt: "2026-01-01T11:00:00+00:00" }, NOW).ok).toBe(true);
  });
});
