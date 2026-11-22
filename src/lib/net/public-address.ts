import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Loopback, private, link-local (incl. cloud metadata), CGNAT, multicast and reserved ranges.
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const)
  blocked.addSubnet(net, prefix, "ipv6");

export function isPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const family = isIP(ip);
  if (family === 0) return false;
  return !blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/** True when every address the host resolves to is public. */
export async function resolvesToPublicAddresses(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPublicAddress(host);
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((a) => isPublicAddress(a.address));
  } catch {
    return false;
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * `lookup` for http(s).request that refuses non-public answers at connect
 * time. The socket connects to exactly the addresses validated here, so a DNS
 * answer that changes between a pre-check and the request (rebinding) cannot
 * reach an internal service.
 */
export function publicOnlyLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || !list.every((a) => isPublicAddress(a.address))) {
      const refused: NodeJS.ErrnoException = new Error(`refusing non-public address for ${hostname}`);
      refused.code = "ENOTPUBLIC";
      return callback(refused, []);
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}
