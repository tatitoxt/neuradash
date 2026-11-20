import { describe, expect, it } from "vitest";
import { bucketStart, bucketStarts, DEFAULT_RANGE, parseRange, RANGES } from "@/lib/range";

describe("range helpers", () => {
  it("parses known ranges and falls back to the default", () => {
    expect(parseRange("7d")).toBe("7d");
    expect(parseRange("1y")).toBe(DEFAULT_RANGE);
    expect(parseRange("__proto__")).toBe(DEFAULT_RANGE);
    expect(parseRange(null)).toBe(DEFAULT_RANGE);
  });

  it("aligns buckets to the epoch like Postgres date_bin", () => {
    expect(bucketStart(Date.parse("2026-01-01T10:07:59Z"), 5 * 60_000)).toBe(Date.parse("2026-01-01T10:05:00Z"));
  });

  it("covers the whole window, oldest first", () => {
    const now = Date.parse("2026-01-01T10:07:00Z");
    const { ms, bucketMs } = RANGES["1h"];
    const starts = bucketStarts(now, ms, bucketMs);
    expect(starts[0]).toBe(Date.parse("2026-01-01T09:05:00Z"));
    expect(starts.at(-1)).toBe(Date.parse("2026-01-01T10:05:00Z"));
    expect(starts).toHaveLength(13);
  });
});
