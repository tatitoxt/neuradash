import { describe, expect, it } from "vitest";
import { isPublicAddress, publicOnlyLookup, resolvesToPublicAddresses } from "@/lib/net/public-address";

describe("isPublicAddress", () => {
  it("rejects loopback, private, link-local, CGNAT, multicast and mapped private addresses", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-ip",
    ]) expect(isPublicAddress(ip), ip).toBe(false);
  });

  it("accepts public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("checks literal hosts without DNS and refuses localhost", async () => {
    expect(await resolvesToPublicAddresses("127.0.0.1")).toBe(false);
    expect(await resolvesToPublicAddresses("[::1]")).toBe(false);
    expect(await resolvesToPublicAddresses("8.8.8.8")).toBe(true);
    expect(await resolvesToPublicAddresses("localhost")).toBe(false);
  });

  it("refuses non-public answers at connect time (DNS rebinding)", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      publicOnlyLookup("localhost", {}, (e) => resolve(e)),
    );
    expect(err?.code).toBe("ENOTPUBLIC");
  });
});
