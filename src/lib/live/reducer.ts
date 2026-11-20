import { bucketStart } from "@/lib/range";
import type { EventDTO, MetricsDTO } from "./types";

export const FEED_SIZE = 50;

export type DashboardState = {
  metrics: MetricsDTO;
  feed: EventDTO[];
  /** Ids applied on top of the metrics snapshot (dedupes live vs. backfill deliveries). */
  applied: Set<number>;
};

export type DashboardAction =
  | { type: "events"; events: EventDTO[]; now: number }
  | { type: "snapshot"; metrics: MetricsDTO; now: number };

export function initDashboard(metrics: MetricsDTO, feed: EventDTO[]): DashboardState {
  return { metrics, feed: mergeFeed([], feed), applied: new Set() };
}

export function mergeFeed(current: EventDTO[], incoming: EventDTO[], size = FEED_SIZE): EventDTO[] {
  const byId = new Map<number, EventDTO>();
  for (const e of current) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, size);
}

/** Applies live events to the KPI summary and the time series of the current range. */
export function applyToMetrics(
  metrics: MetricsDTO,
  events: EventDTO[],
  applied: Set<number>,
  now: number,
): MetricsDTO {
  const fresh = events.filter((e) => e.id > metrics.lastEventId && !applied.has(e.id));
  if (fresh.length === 0) return metrics;

  const summary = { ...metrics.summary };
  const sourceNames = new Set(metrics.sourceNames);
  let series = metrics.series.map((p) => ({ ...p }));
  const from = now - metrics.rangeMs;

  for (const e of fresh) {
    applied.add(e.id);
    const at = Date.parse(e.occurredAt);
    if (at < from || at > now) continue;
    summary.events += 1;
    if (e.type === "error") summary.errors += 1;
    if (e.type === "purchase" && e.value) summary.revenue += e.value;
    sourceNames.add(e.source);

    const t = bucketStart(at, metrics.bucketMs);
    const last = series.at(-1)?.t ?? t;
    // Extend the window when time has moved past the last bucket, dropping the oldest.
    for (let next = last + metrics.bucketMs; next <= t; next += metrics.bucketMs) {
      series.push({ t: next, events: 0, errors: 0, revenue: 0 });
    }
    series = series.filter((p) => p.t >= bucketStart(from, metrics.bucketMs));
    const point = series.find((p) => p.t === t);
    if (point) {
      point.events += 1;
      if (e.type === "error") point.errors += 1;
      if (e.type === "purchase" && e.value) point.revenue += e.value;
    }
  }
  summary.revenue = Math.round(summary.revenue * 100) / 100;
  summary.sources = sourceNames.size;
  return { ...metrics, summary, series, sourceNames: [...sourceNames] };
}

export function dashboardReducer(state: DashboardState, action: DashboardAction): DashboardState {
  switch (action.type) {
    case "events": {
      const applied = new Set(state.applied);
      return {
        metrics: applyToMetrics(state.metrics, action.events, applied, action.now),
        feed: mergeFeed(state.feed, action.events),
        applied,
      };
    }
    case "snapshot": {
      // The snapshot contains every event up to its lastEventId; re-apply newer ones we already hold.
      const applied = new Set<number>();
      return { ...state, metrics: applyToMetrics(action.metrics, state.feed, applied, action.now), applied };
    }
  }
}

export function maxEventId(state: DashboardState): number {
  return Math.max(state.metrics.lastEventId, state.feed[0]?.id ?? 0);
}
