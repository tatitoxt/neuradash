import type { RangeKey } from "@/lib/range";

export type EventDTO = {
  id: number;
  type: string;
  source: string;
  value: number | null;
  properties: Record<string, unknown>;
  occurredAt: string;
  receivedAt: string;
};

export type Summary = {
  events: number;
  errors: number;
  revenue: number;
  sources: number;
};

export type SeriesPoint = {
  t: number;
  events: number;
  errors: number;
  revenue: number;
};

export type MetricsDTO = {
  range: RangeKey;
  bucketMs: number;
  rangeMs: number;
  generatedAt: string;
  summary: Summary;
  series: SeriesPoint[];
  /** Distinct sources in range; lets the client keep the "sources" KPI exact while live. */
  sourceNames: string[];
};

/** Messages sent by the server over /ws. */
export type ServerMessage =
  | { type: "ready"; tenant: string; lastEventId: number }
  | { type: "event"; event: EventDTO }
  | { type: "backfill"; events: EventDTO[]; truncated: boolean }
  | { type: "error"; code: string };

/** Messages sent by the browser over /ws. */
export type ClientMessage = { type: "resume"; lastEventId: number } | { type: "ping" };
