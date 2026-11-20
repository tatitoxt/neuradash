import { describe, expect, it } from "vitest";
import { apiKeyDisplayPrefix, generateApiKey, generateSessionToken, sha256Hex } from "@/lib/auth/tokens";

describe("tokens", () => {
  it("generates 256-bit url-safe session tokens", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSessionToken()).not.toEqual(token);
  });

  it("generates prefixed API keys with a short display prefix", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^nd_[0-9a-f]{40}$/);
    expect(apiKeyDisplayPrefix(key)).toBe(key.slice(0, 9));
  });

  it("hashes with SHA-256 hex", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
