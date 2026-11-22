export const RANGES = {
  "15m": { label: "15 min", ms: 15 * 60_000, bucketMs: 60_000 },
  "1h": { label: "1 hour", ms: 60 * 60_000, bucketMs: 5 * 60_000 },
  "24h": { label: "24 hours", ms: 24 * 60 * 60_000, bucketMs: 60 * 60_000 },
  "7d": { label: "7 days", ms: 7 * 24 * 60 * 60_000, bucketMs: 6 * 60 * 60_000 },
} as const;

export type RangeKey = keyof typeof RANGES;
export const DEFAULT_RANGE: RangeKey = "1h";

export function parseRange(value: string | null | undefined): RangeKey {
  return value && Object.hasOwn(RANGES, value) ? (value as RangeKey) : DEFAULT_RANGE;
}

/** Same alignment as Postgres `date_bin(bucket, ts, 'epoch')`. */
export function bucketStart(timestampMs: number, bucketMs: number): number {
  return Math.floor(timestampMs / bucketMs) * bucketMs;
}

/** Bucket starts covering [nowMs - rangeMs, nowMs], oldest first. */
export function bucketStarts(nowMs: number, rangeMs: number, bucketMs: number): number[] {
  const last = bucketStart(nowMs, bucketMs);
  const first = bucketStart(nowMs - rangeMs, bucketMs);
  const out: number[] = [];
  for (let t = first; t <= last; t += bucketMs) out.push(t);
  return out;
}
