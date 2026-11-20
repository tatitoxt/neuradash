import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

const FAST = { N: 1024, r: 8, p: 1 };

describe("password hashing", () => {
  it("verifies the correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse", FAST);
    expect(hash.startsWith("scrypt$1024$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse", hash)).toBe(true);
    expect(await verifyPassword("wrong horse", hash)).toBe(false);
  });

  it("uses a random salt per hash", async () => {
    expect(await hashPassword("same", FAST)).not.toEqual(await hashPassword("same", FAST));
  });

  it("normalizes unicode before hashing", async () => {
    const hash = await hashPassword("caf\u00e9", FAST);
    expect(await verifyPassword("cafe\u0301", hash)).toBe(true);
  });

  it("rejects malformed hashes instead of throwing", async () => {
    for (const bad of ["", "bcrypt$x", "scrypt$a$b$c$d$e", "scrypt$1024$8$1$AAAA$AAAA"]) {
      expect(await verifyPassword("x", bad)).toBe(false);
    }
  });
});
