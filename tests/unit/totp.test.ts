import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, totpNow, totpUri, verifyTotp } from "@/lib/auth/totp";

// RFC 6238 Appendix B, SHA-1 seed "12345678901234567890"; we use the last 6 of the 8 published digits.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const VECTORS: Array<[number, string]> = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

describe("totp", () => {
  it("matches the RFC 6238 SHA-1 test vectors", () => {
    for (const [seconds, code] of VECTORS) expect(totpNow(RFC_SECRET, new Date(seconds * 1000))).toBe(code);
  });

  it("round-trips base32 and generates 160-bit secrets", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    expect(() => base32Decode("not!base32")).toThrow();
  });

  it("accepts one step of clock skew and nothing beyond", () => {
    const at = new Date(1234567890 * 1000);
    const code = totpNow(RFC_SECRET, at);
    expect(verifyTotp(RFC_SECRET, code, at)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, new Date(at.getTime() + 30_000))).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, new Date(at.getTime() - 30_000))).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, new Date(at.getTime() + 90_000))).toBe(false);
  });

  it("rejects malformed codes", () => {
    for (const bad of ["", "12345", "1234567", "abcdef"]) expect(verifyTotp(RFC_SECRET, bad)).toBe(false);
  });

  it("builds an otpauth URI", () => {
    expect(totpUri("ABC", "a@b.test")).toBe(
      "otpauth://totp/NeuraDash%3Aa%40b.test?secret=ABC&issuer=NeuraDash&algorithm=SHA1&digits=6&period=30",
    );
  });
});
