"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { Charts } from "@/components/charts";
import { KpiCards } from "@/components/kpi-cards";
import { LiveFeed } from "@/components/live-feed";
import { RangeFilter } from "@/components/range-filter";
import { useLiveEvents, type LiveStatus } from "@/components/use-live-events";
import { dashboardReducer, initDashboard, maxEventId } from "@/lib/live/reducer";
import type { EventDTO, MetricsDTO } from "@/lib/live/types";
import { RANGES } from "@/lib/range";

const RESYNC_MS = 60_000;

const statusStyle: Record<LiveStatus, string> = {
  connecting: "bg-amber-500/15 text-amber-300",
  live: "bg-emerald-500/15 text-emerald-300",
  reconnecting: "bg-amber-500/15 text-amber-300",
  "signed-out": "bg-red-500/15 text-red-300",
};

export function Dashboard({ initialMetrics, initialFeed }: { initialMetrics: MetricsDTO; initialFeed: EventDTO[] }) {
  const [state, dispatch] = useReducer(dashboardReducer, undefined, () => initDashboard(initialMetrics, initialFeed));
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const range = initialMetrics.range;

  const resync = useCallback(async () => {
    const res = await fetch(`/api/metrics?range=${range}`, { cache: "no-store" });
    if (res.ok) dispatch({ type: "snapshot", metrics: (await res.json()) as MetricsDTO, now: Date.now() });
  }, [range]);

  const status = useLiveEvents({
    getLastEventId: () => maxEventId(stateRef.current),
    onEvents: (events) => dispatch({ type: "events", events, now: Date.now() }),
    onReconnect: () => void resync(),
  });

  // Periodic resync lets old events age out of the window.
  useEffect(() => {
    const id = setInterval(() => void resync(), RESYNC_MS);
    return () => clearInterval(id);
  }, [resync]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">Last {RANGES[range].label}</h1>
          <span className={`rounded-full px-2 py-0.5 text-xs ${statusStyle[status]}`} data-testid="live-status">
            {status}
          </span>
        </div>
        <RangeFilter current={range} />
      </div>
      <KpiCards summary={state.metrics.summary} />
      <Charts series={state.metrics.series} bucketMs={state.metrics.bucketMs} />
      <LiveFeed events={state.feed} />
    </div>
  );
}
