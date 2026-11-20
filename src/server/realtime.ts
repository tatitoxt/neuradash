import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import pg from "pg";
import { WebSocketServer, type WebSocket } from "ws";
import { getSession, type Session } from "@/lib/auth/session";
import { EVENTS_CHANNEL, getEventsByIds, latestEventId, listEventsAfter } from "@/lib/data/events";
import { isSameOrigin, sessionTokenFrom } from "@/lib/http";
import type { ClientMessage, EventDTO, ServerMessage } from "@/lib/live/types";

export const WS_PATH = "/ws";
export const CLOSE_SESSION_INVALID = 4401;

type Client = { ws: WebSocket; token: string; session: Session; alive: boolean };

export type RealtimeOptions = {
  /** Connection used for LISTEN (the RLS-restricted app role is enough). */
  listenConnectionString: string;
  heartbeatMs?: number;
  log?: (msg: string) => void;
};

export type Realtime = {
  /** Resolves once the LISTEN connection is active. */
  ready: Promise<void>;
  /** Returns false when the request is not for {@link WS_PATH}, so the caller can delegate it. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  connectionCount(tenantId?: string): number;
  close(): Promise<void>;
};

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function reject(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function parseClientMessage(data: unknown): ClientMessage | null {
  try {
    const msg = JSON.parse(String(data)) as Partial<ClientMessage>;
    if (msg.type === "ping") return { type: "ping" };
    if (msg.type === "resume" && Number.isSafeInteger(msg.lastEventId) && (msg.lastEventId as number) >= 0) {
      return { type: "resume", lastEventId: msg.lastEventId as number };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Authenticated, tenant-scoped WebSocket fan-out.
 * Ingest NOTIFYs `{tenantId, ids}`; rows are re-read under that tenant's RLS context and
 * sent only to sockets whose session belongs to the same tenant.
 */
export function createRealtime(opts: RealtimeOptions): Realtime {
  const log = opts.log ?? ((m) => console.log(`[realtime] ${m}`));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const byTenant = new Map<string, Set<Client>>();
  let closed = false;
  let listener: pg.Client | null = null;
  let retryTimer: NodeJS.Timeout | undefined;

  function broadcast(tenantId: string, events: EventDTO[]) {
    const clients = byTenant.get(tenantId);
    if (!clients) return;
    for (const event of events) {
      for (const c of clients) {
        if (c.session.tenantId === tenantId) send(c.ws, { type: "event", event });
      }
    }
  }

  async function onNotification(payload: string | undefined) {
    try {
      const { tenantId, ids } = JSON.parse(payload ?? "{}") as { tenantId?: string; ids?: number[] };
      if (!tenantId || !Array.isArray(ids) || !byTenant.get(tenantId)?.size) return;
      broadcast(tenantId, await getEventsByIds(tenantId, ids));
    } catch (err) {
      log(`notification error: ${(err as Error).message}`);
    }
  }

  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));

  async function connectListener(attempt = 0): Promise<void> {
    if (closed) return;
    const client = new pg.Client({ connectionString: opts.listenConnectionString });
    client.on("notification", (n) => void onNotification(n.payload));
    client.on("error", (err) => {
      log(`listener error: ${err.message}`);
      scheduleReconnect(0);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${EVENTS_CHANNEL}`);
      listener = client;
      resolveReady();
    } catch (err) {
      log(`listener connect failed: ${(err as Error).message}`);
      await client.end().catch(() => {});
      scheduleReconnect(attempt + 1);
    }
  }

  function scheduleReconnect(attempt: number) {
    if (closed || retryTimer) return;
    const old = listener;
    listener = null;
    void old?.end().catch(() => {});
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connectListener(attempt);
    }, Math.min(30_000, 500 * 2 ** attempt));
  }

  void connectListener();

  function register(ws: WebSocket, token: string, session: Session) {
    const client: Client = { ws, token, session, alive: true };
    const set = byTenant.get(session.tenantId) ?? new Set<Client>();
    set.add(client);
    byTenant.set(session.tenantId, set);

    ws.on("pong", () => (client.alive = true));
    // e.g. a frame above maxPayload; ws closes the socket itself, we only need to observe it.
    ws.on("error", (err) => log(`socket error: ${err.message}`));
    ws.on("close", () => {
      set.delete(client);
      if (set.size === 0) byTenant.delete(session.tenantId);
    });
    ws.on("message", async (data) => {
      const msg = parseClientMessage(data);
      if (!msg) return send(ws, { type: "error", code: "bad_message" });
      if (msg.type === "resume") {
        try {
          const { events, truncated } = await listEventsAfter(session.tenantId, msg.lastEventId);
          send(ws, { type: "backfill", events, truncated });
        } catch (err) {
          log(`backfill failed: ${(err as Error).message}`);
          send(ws, { type: "error", code: "backfill_failed" });
        }
      }
    });

    void latestEventId(session.tenantId)
      .then((lastEventId) => send(ws, { type: "ready", tenant: session.tenantSlug, lastEventId }))
      .catch((err) => {
        log(`ready failed: ${(err as Error).message}`);
        ws.close(1011, "server error");
      });
  }

  const heartbeat = setInterval(() => {
    for (const set of byTenant.values()) {
      for (const c of set) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
        // Logout, expiry or a removed membership disconnects live sockets too.
        void getSession(c.token)
          .then((s) => {
            if (!s || s.tenantId !== c.session.tenantId) c.ws.close(CLOSE_SESSION_INVALID, "session invalid");
            else c.session = s;
          })
          // Keep the socket on a transient DB error; the next heartbeat re-checks the session.
          .catch((err) => log(`session check failed: ${(err as Error).message}`));
      }
    }
  }, opts.heartbeatMs ?? 30_000);
  heartbeat.unref();

  return {
    ready,
    handleUpgrade(req, socket, head) {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path !== WS_PATH) return false;
      if (!isSameOrigin({ origin: req.headers.origin, host: req.headers.host })) {
        reject(socket, 403, "Forbidden");
        return true;
      }
      const token = sessionTokenFrom({ cookie: req.headers.cookie });
      void Promise.resolve()
        .then(() => getSession(token))
        .then((session) => {
          if (!session || !token) return reject(socket, 401, "Unauthorized");
          wss.handleUpgrade(req, socket, head, (ws) => register(ws, token, session));
        })
        .catch((err) => {
          log(`upgrade failed: ${(err as Error).message}`);
          reject(socket, 500, "Internal Server Error");
        });
      return true;
    },
    connectionCount(tenantId) {
      if (tenantId) return byTenant.get(tenantId)?.size ?? 0;
      let n = 0;
      for (const s of byTenant.values()) n += s.size;
      return n;
    },
    async close() {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(retryTimer);
      for (const set of byTenant.values()) for (const c of set) c.ws.terminate();
      byTenant.clear();
      await new Promise<void>((r) => wss.close(() => r()));
      await listener?.end().catch(() => {});
    },
  };
}
