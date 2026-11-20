import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSessionCookie, serializeSessionCookie } from "@/lib/auth/session";
import { isSameOrigin, parseCookies, readJson, sessionTokenFrom } from "@/lib/http";
import { FixedWindowLimiter } from "@/lib/rate-limit";
import { backoffDelay } from "@/components/use-live-events";

afterEach(() => vi.unstubAllEnvs());

describe("cookies", () => {
  it("parses cookie headers and keeps the first occurrence", () => {
    expect(parseCookies("a=1; nd_session=abc%3D; a=2")).toEqual({ a: "1", nd_session: "abc=" });
    expect(sessionTokenFrom(new Headers({ cookie: "nd_session=tok" }))).toBe("tok");
    expect(sessionTokenFrom({ cookie: undefined })).toBeUndefined();
    expect(parseCookies("x=%; nd_session=ok")).toEqual({ nd_session: "ok" });
  });

  it("serializes an HttpOnly, SameSite=Lax session cookie, Secure in production", () => {
    vi.stubEnv("COOKIE_SECURE", "");
    vi.stubEnv("NODE_ENV", "production");
    const cookie = serializeSessionCookie("tok");
    expect(cookie).toContain("nd_session=tok");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    vi.stubEnv("COOKIE_SECURE", "false");
    expect(serializeSessionCookie("tok")).not.toContain("Secure");
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });
});

describe("isSameOrigin", () => {
  it("requires Origin to match Host", () => {
    expect(isSameOrigin(new Headers({ origin: "http://localhost:3000", host: "localhost:3000" }))).toBe(true);
    expect(isSameOrigin(new Headers({ origin: "https://evil.example", host: "localhost:3000" }))).toBe(false);
    expect(isSameOrigin(new Headers({ host: "localhost:3000" }))).toBe(false);
    expect(isSameOrigin({ origin: "not a url", host: "x" })).toBe(false);
  });
});

describe("FixedWindowLimiter", () => {
  it("blocks after the limit and resets after the window", () => {
    const l = new FixedWindowLimiter(2, 1000);
    expect([l.take("k", 0), l.take("k", 1), l.take("k", 2)]).toEqual([true, true, false]);
    expect(l.take("other", 2)).toBe(true);
    expect(l.take("k", 1001)).toBe(true);
    l.reset("k");
    expect(l.take("k", 1002)).toBe(true);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially with jitter and caps at 15s", () => {
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(10, () => 1)).toBe(15000);
  });
});

describe("readJson", () => {
  function chunked(parts: string[]) {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    });
    return new Request("http://x/", { method: "POST", body, duplex: "half" } as RequestInit);
  }

  it("enforces the size limit on bodies without Content-Length", async () => {
    const res = await readJson(chunked(["[", "1,".repeat(100), "1]"]), 64);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.response.status).toBe(413);
  });

  it("parses bodies within the limit and rejects invalid JSON", async () => {
    expect(await readJson(chunked(['{"a":', "1}"]), 64)).toEqual({ ok: true, body: { a: 1 } });
    const bad = await readJson(chunked(["{nope"]), 64);
    expect(!bad.ok && bad.response.status).toBe(400);
  });
});
