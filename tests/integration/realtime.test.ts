import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { login, deleteSession } from "@/lib/auth/session";
import { closeDb } from "@/lib/db/client";
import { insertEvents } from "@/lib/data/events";
import { DEMO_PASSWORD } from "@/lib/seed";
import type { ServerMessage } from "@/lib/live/types";
import { CLOSE_SESSION_INVALID, createRealtime, type Realtime } from "@/server/realtime";
import { reseed } from "./helpers";

let seeded: Awaited<ReturnType<typeof reseed>>;
let server: Server;
let realtime: Realtime;
let origin: string;
const sockets: WebSocket[] = [];

type Conn = { ws: WebSocket; messages: ServerMessage[]; next(pred: (m: ServerMessage) => boolean, ms?: number): Promise<ServerMessage> };

async function token(email: string): Promise<string> {
  const r = await login(email, DEMO_PASSWORD);
  if (!r.ok || "mfa" in r) throw new Error("login failed");
  return r.token;
}

function connect(cookie: string | null, target = origin, wsOrigin = target): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { origin: wsOrigin };
    if (cookie) headers.cookie = `nd_session=${cookie}`;
    const ws = new WebSocket(`${target.replace("http", "ws")}/ws`, { headers });
    sockets.push(ws);
    const messages: ServerMessage[] = [];
    const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      messages.push(msg);
      for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    });
    const next: Conn["next"] = (pred, ms = 5000) =>
      new Promise((res, rej) => {
        const found = messages.find(pred);
        if (found) return res(found);
        const timer = setTimeout(() => rej(new Error("timed out waiting for message")), ms);
        waiters.push({ pred, resolve: (m) => { clearTimeout(timer); res(m); } });
      });
    ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on("error", reject);
    ws.on("open", () => resolve({ ws, messages, next }));
  });
}

const isEvent = (source: string) => (m: ServerMessage) => m.type === "event" && m.event.source === source;

beforeAll(async () => {
  seeded = await reseed(20);
  realtime = createRealtime({ listenConnectionString: process.env.DATABASE_URL!, heartbeatMs: 200, log: () => {} });
  server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
    if (!realtime.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await realtime.ready;
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await realtime.close();
  await new Promise((r) => server.close(r));
  await closeDb();
});

describe("WebSocket authentication", () => {
  it("rejects connections without a valid session", async () => {
    await expect(connect(null)).rejects.toThrow("HTTP 401");
    await expect(connect("forged-token")).rejects.toThrow("HTTP 401");
  });

  it("rejects cross-origin connections even with a valid session", async () => {
    await expect(connect(await token("admin@acme.test"), origin, "https://evil.example")).rejects.toThrow("HTTP 403");
  });

  it("announces the session's tenant on connect", async () => {
    const c = await connect(await token("viewer@acme.test"));
    expect(await c.next((m) => m.type === "ready")).toMatchObject({ type: "ready", tenant: "acme" });
  });
});

describe("tenant-scoped broadcast", () => {
  it("delivers events only to sockets of the event's tenant", async () => {
    const acme = await connect(await token("admin@acme.test"));
    const globex = await connect(await token("admin@globex.test"));
    await Promise.all([acme.next((m) => m.type === "ready"), globex.next((m) => m.type === "ready")]);

    await insertEvents(seeded.globex!.tenantId, [{ type: "signup", source: "globex-private", value: null, properties: {}, occurredAt: new Date() }]);
    await insertEvents(seeded.acme!.tenantId, [{ type: "signup", source: "acme-public", value: null, properties: {}, occurredAt: new Date() }]);

    await acme.next(isEvent("acme-public"));
    await globex.next(isEvent("globex-private"));
    // The acme event arrived after the globex one was published, so the acme socket has seen everything it will get.
    expect(acme.messages.some(isEvent("globex-private"))).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(globex.messages.some(isEvent("acme-public"))).toBe(false);
  });
});

describe("reconnect backfill", () => {
  it("returns events after lastEventId for the session's tenant only", async () => {
    const c = await connect(await token("admin@acme.test"));
    const ready = (await c.next((m) => m.type === "ready")) as Extract<ServerMessage, { type: "ready" }>;
    c.ws.close();

    const now = new Date();
    const [missed] = await insertEvents(seeded.acme!.tenantId, [{ type: "purchase", source: "missed-while-offline", value: 3, properties: {}, occurredAt: now }]);
    await insertEvents(seeded.globex!.tenantId, [{ type: "purchase", source: "globex-missed", value: 3, properties: {}, occurredAt: now }]);

    const again = await connect(await token("admin@acme.test"));
    again.ws.send(JSON.stringify({ type: "resume", lastEventId: ready.lastEventId }));
    const backfill = (await again.next((m) => m.type === "backfill")) as Extract<ServerMessage, { type: "backfill" }>;
    expect(backfill.events.map((e) => e.source)).toContain("missed-while-offline");
    expect(backfill.events.some((e) => e.source === "globex-missed")).toBe(false);
    expect(backfill.events.every((e) => e.id > ready.lastEventId)).toBe(true);
    expect(backfill.events.find((e) => e.id === missed!.id)).toBeDefined();
  });

  it("rejects malformed client messages", async () => {
    const c = await connect(await token("viewer@acme.test"));
    c.ws.send("not json");
    expect(await c.next((m) => m.type === "error")).toEqual({ type: "error", code: "bad_message" });
  });
});

describe("multi-instance fan-out", () => {
  it("delivers an event to a socket on a different instance via Postgres NOTIFY", async () => {
    // Two independent realtime instances (separate LISTEN connection and client
    // registry) stand in for two app processes on one database.
    const rt2 = createRealtime({ listenConnectionString: process.env.DATABASE_URL!, heartbeatMs: 200, log: () => {} });
    const server2 = createServer((_req, res) => res.writeHead(404).end());
    server2.on("upgrade", (req, socket, head) => {
      if (!rt2.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => server2.listen(0, "127.0.0.1", r));
    const origin2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
    try {
      await rt2.ready;
      const remote = await connect(await token("viewer@acme.test"), origin2);
      await remote.next((m) => m.type === "ready");
      // The event is written under this test's node — instance B hears it only
      // because ingest's pg_notify crosses the database.
      await insertEvents(seeded.acme!.tenantId, [
        { type: "signup", source: "acme-cross-instance", value: null, properties: {}, occurredAt: new Date() },
      ]);
      const delivered = await remote.next(isEvent("acme-cross-instance"));
      expect(delivered.type).toBe("event");
      expect(rt2.connectionCount(seeded.acme!.tenantId)).toBe(1);
    } finally {
      await rt2.close();
      await new Promise((r) => server2.close(r));
    }
  });
});

describe("session revocation", () => {
  it("closes live sockets after logout", async () => {
    const t = await token("viewer@acme.test");
    const c = await connect(t);
    await c.next((m) => m.type === "ready");
    const closed = new Promise<number>((r) => c.ws.on("close", (code) => r(code)));
    await deleteSession(t);
    expect(await closed).toBe(CLOSE_SESSION_INVALID);
  });
});

describe("robustness", () => {
  it("survives malformed cookies and oversized frames", async () => {
    await expect(connect("x=%")).rejects.toThrow("HTTP 401");
    const c = await connect(await token("viewer@acme.test"));
    await c.next((m) => m.type === "ready");
    const closed = new Promise<number>((r) => c.ws.on("close", (code) => r(code)));
    c.ws.send("x".repeat(10_000));
    expect(await closed).toBe(1009);
    const again = await connect(await token("viewer@acme.test"));
    expect(await again.next((m) => m.type === "ready")).toMatchObject({ tenant: "acme" });
  });
});
