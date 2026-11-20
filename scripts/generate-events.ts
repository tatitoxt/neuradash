/**
 * Synthetic telemetry generator: POSTs random events to /api/ingest using per-tenant API keys.
 *
 *   NEURADASH_URL       base URL (default http://localhost:3000)
 *   NEURADASH_API_KEYS  comma-separated ingest keys (default: both local demo keys)
 *   EVENTS_PER_SECOND   per key (default 1)
 *   EVENT_COUNT         stop after this many events per key (default: run forever)
 */
import { mulberry32, syntheticEvent } from "@/lib/seed";

const DEMO_KEYS = ["nd_demo_acme_local_only_0000000000000000", "nd_demo_globex_local_only_00000000000000"];

const baseUrl = (process.env.NEURADASH_URL ?? "http://localhost:3000").replace(/\/$/, "");
const keys = (process.env.NEURADASH_API_KEYS ?? DEMO_KEYS.join(",")).split(",").map((k) => k.trim()).filter(Boolean);
const rate = Number(process.env.EVENTS_PER_SECOND ?? 1);
const limit = process.env.EVENT_COUNT ? Number(process.env.EVENT_COUNT) : Infinity;
if (!(rate > 0) || !(limit > 0)) throw new Error("EVENTS_PER_SECOND and EVENT_COUNT must be positive numbers");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(key: string, seed: number) {
  const rand = mulberry32(seed);
  for (let sent = 0; sent < limit; ) {
    const { type, source, value, properties } = syntheticEvent(rand, 0.04);
    try {
      const res = await fetch(`${baseUrl}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ type, source, value, properties }),
      });
      if (res.status === 202) sent += 1;
      else console.error(`[${key.slice(0, 9)}] ingest returned ${res.status}: ${await res.text()}`);
    } catch (err) {
      console.error(`[${key.slice(0, 9)}] ${(err as Error).message}; retrying`);
      await sleep(2000);
    }
    await sleep((1000 / rate) * (0.5 + rand()));
  }
  console.log(`[${key.slice(0, 9)}] done`);
}

console.log(`sending synthetic events to ${baseUrl} for ${keys.length} key(s) at ~${rate}/s each`);
Promise.all(keys.map((k, i) => run(k, Date.now() + i))).catch((err) => {
  console.error(err);
  process.exit(1);
});
