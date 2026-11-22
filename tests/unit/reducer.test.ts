import { describe, expect, it } from "vitest";
import { dashboardReducer, FEED_SIZE, initDashboard, maxEventId, mergeFeed } from "@/lib/live/reducer";
import type { EventDTO, MetricsDTO } from "@/lib/live/types";
import { bucketStarts, RANGES } from "@/lib/range";

const NOW = Date.parse("2026-01-01T10:00:30Z");

function metrics(lastEventId = 10): MetricsDTO {
  const { ms, bucketMs } = RANGES["15m"];
  return {
    range: "15m",
    rangeMs: ms,
    bucketMs,
    generatedAt: new Date(NOW).toISOString(),
    lastEventId,
    summary: { events: 5, errors: 1, revenue: 10, sources: 1 },
    series: bucketStarts(NOW, ms, bucketMs).map((t) => ({ t, events: 0, errors: 0, revenue: 0 })),
    sourceNames: ["web"],
  };
}

function ev(id: number, type = "page_view", extra: Partial<EventDTO> = {}): EventDTO {
  const at = new Date(NOW - 1000).toISOString();
  return { id, type, source: "web", value: null, properties: {}, occurredAt: at, receivedAt: at, ...extra };
}

describe("dashboardReducer", () => {
  it("applies live events to KPIs, the current bucket and the feed", () => {
    let s = initDashboard(metrics(), []);
    s = dashboardReducer(s, {
      type: "events",
      events: [ev(11), ev(12, "error", { source: "ios" }), ev(13, "purchase", { value: 2.5 })],
      now: NOW,
    });
    expect(s.metrics.summary).toEqual({ events: 8, errors: 2, revenue: 12.5, sources: 2 });
    expect(s.metrics.series.at(-1)).toMatchObject({ events: 3, errors: 1, revenue: 2.5 });
    expect(s.feed.map((e) => e.id)).toEqual([13, 12, 11]);
    expect(maxEventId(s)).toBe(13);
  });

  it("ignores duplicates and events already in the snapshot", () => {
    let s = initDashboard(metrics(10), []);
    s = dashboardReducer(s, { type: "events", events: [ev(9), ev(11)], now: NOW });
    s = dashboardReducer(s, { type: "events", events: [ev(11)], now: NOW });
    expect(s.metrics.summary.events).toBe(6);
    expect(s.feed.map((e) => e.id)).toEqual([11, 9]);
  });

  it("does not count events outside the time window", () => {
    const old = ev(11, "page_view", { occurredAt: new Date(NOW - 60 * 60_000).toISOString() });
    const s = dashboardReducer(initDashboard(metrics(), []), { type: "events", events: [old], now: NOW });
    expect(s.metrics.summary.events).toBe(5);
    expect(s.feed).toHaveLength(1);
  });

  it("rolls the series window forward when time passes", () => {
    const later = NOW + 3 * 60_000;
    const e = ev(11, "page_view", { occurredAt: new Date(later).toISOString() });
    const s = dashboardReducer(initDashboard(metrics(), []), { type: "events", events: [e], now: later });
    const { series } = s.metrics;
    expect(series.at(-1)?.t).toBe(Math.floor(later / 60_000) * 60_000);
    expect(series.at(-1)?.events).toBe(1);
    expect(series).toHaveLength(metrics().series.length);
  });

  it("re-applies held events newer than a fresh snapshot", () => {
    let s = initDashboard(metrics(10), []);
    s = dashboardReducer(s, { type: "events", events: [ev(11), ev(12)], now: NOW });
    s = dashboardReducer(s, { type: "snapshot", metrics: { ...metrics(11), summary: { events: 6, errors: 1, revenue: 10, sources: 1 } }, now: NOW });
    expect(s.metrics.summary.events).toBe(7);
    expect(s.metrics.lastEventId).toBe(11);
  });

  it("keeps the feed bounded and sorted newest first", () => {
    const many = Array.from({ length: FEED_SIZE + 10 }, (_, i) => ev(i + 1));
    const feed = mergeFeed([], many);
    expect(feed).toHaveLength(FEED_SIZE);
    expect(feed[0]?.id).toBe(FEED_SIZE + 10);
  });
});
