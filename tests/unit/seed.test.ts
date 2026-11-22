import { describe, expect, it } from "vitest";
import { mulberry32, syntheticEvent } from "@/lib/seed";

describe("synthetic data", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
  });

  it("produces roughly the configured error rate", () => {
    const rand = mulberry32(7);
    const events = Array.from({ length: 5000 }, () => syntheticEvent(rand, 0.1));
    const rate = events.filter((e) => e.type === "error").length / events.length;
    expect(rate).toBeGreaterThan(0.08);
    expect(rate).toBeLessThan(0.12);
    expect(events.filter((e) => e.type === "purchase").every((e) => typeof e.value === "number")).toBe(true);
  });
});
