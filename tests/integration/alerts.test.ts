import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as alertsRoute from "@/app/api/admin/alerts/route";
import * as alertByIdRoute from "@/app/api/admin/alerts/[id]/route";
import * as ingestRoute from "@/app/api/ingest/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as membersRoute from "@/app/api/admin/members/route";
import * as memberRoute from "@/app/api/admin/members/[id]/route";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { deliverAlert, listAlertEvents, sweepAlertRetries, type FiredAlert } from "@/lib/data/alerts";
import { appClient, cookieFrom, request, reseed, sameOrigin } from "./helpers";

let cookie: string;
let acmeApiKey = "";
let acmeTenantId = "";
let globexCookie = "";

const DEMO_PASSWORD = "neuradash-demo";

async function loginAs(email: string): Promise<string> {
  const res = await loginRoute.POST(
    request("/api/auth/login", sameOrigin({ method: "POST", body: JSON.stringify({ email, password: DEMO_PASSWORD }) })),
  );
  return cookieFrom(res);
}

async function ingest(body: unknown) {
  return ingestRoute.POST(
    request("/api/ingest", { method: "POST", headers: { authorization: `Bearer ${acmeApiKey}` }, body: JSON.stringify(body) }),
  );
}

async function createRule(body: unknown) {
  return alertsRoute.POST(request("/api/admin/alerts", sameOrigin({ method: "POST", cookie, body: JSON.stringify(body) })));
}

beforeAll(async () => {
  const seeded = await reseed(5);
  acmeApiKey = seeded.acme!.apiKey;
  acmeTenantId = seeded.acme!.tenantId;
  cookie = await loginAs("admin@acme.test");
  globexCookie = await loginAs("admin@globex.test");
});

describe("alert rule CRUD", () => {
  it("creates, lists, patches and deletes rules; enforces tenant isolation", async () => {
    const res = await createRule({ name: "error-spike", metric: "errors", op: ">", threshold: 3, webhookUrl: "http://127.0.0.1:1/hook", cooldownMinutes: 30 });
    expect(res.status).toBe(201);
    const { rule } = await res.json();
    expect(rule.name).toBe("error-spike");

    const dup = await createRule({ name: "error-spike", metric: "events", op: ">", threshold: 1, webhookUrl: "http://127.0.0.1:1/x" });
    expect(dup.status).toBe(409);

    const list = await alertsRoute.GET(request("/api/admin/alerts", { cookie }));
    const { rules } = await list.json();
    expect(rules.map((r: { name: string }) => r.name)).toContain("error-spike");

    // Another tenant cannot see or touch it.
    const other = await alertsRoute.GET(request("/api/admin/alerts", { cookie: globexCookie }));
    expect((await other.json()).rules).toHaveLength(0);
    const otherDel = await alertByIdRoute.DELETE(
      request(`/api/admin/alerts/${rule.id}`, sameOrigin({ method: "DELETE", cookie: globexCookie })),
      { params: Promise.resolve({ id: rule.id }) },
    );
    expect(otherDel.status).toBe(404);

    const patched = await alertByIdRoute.PATCH(
      request(`/api/admin/alerts/${rule.id}`, sameOrigin({ method: "PATCH", cookie, body: JSON.stringify({ enabled: false, threshold: 5 }) })),
      { params: Promise.resolve({ id: rule.id }) },
    );
    expect((await patched.json()).rule).toMatchObject({ enabled: false, threshold: 5 });

    const del = await alertByIdRoute.DELETE(
      request(`/api/admin/alerts/${rule.id}`, sameOrigin({ method: "DELETE", cookie })),
      { params: Promise.resolve({ id: rule.id }) },
    );
    expect(del.status).toBe(200);
  });

  it("rejects invalid rule bodies and non-admin access", async () => {
    expect((await createRule({ name: "x", metric: "nope", op: ">", threshold: 1, webhookUrl: "http://a.b" })).status).toBe(422);
    expect((await createRule({ name: "x", metric: "errors", op: "!=", threshold: 1, webhookUrl: "http://a.b" })).status).toBe(422);
    expect((await createRule({ name: "x", metric: "errors", op: ">", threshold: 1, webhookUrl: "ftp://a.b" })).status).toBe(422);
    const viewer = await loginAs("viewer@acme.test");
    const res = await alertsRoute.POST(request("/api/admin/alerts", sameOrigin({ method: "POST", cookie: viewer, body: "{}" })));
    expect(res.status).toBe(403);
  });
});

describe("alert evaluation", () => {
  it("fires a rule on ingest, records the event and respects cooldown", async () => {
    const res = await createRule({ name: "burst", metric: "events", op: ">=", threshold: 2, webhookUrl: "http://127.0.0.1:1/hook" });
    const { rule } = await res.json();

    const first = await ingest({ events: [{ type: "signup" }, { type: "signup" }] });
    expect((await first.json()).alertsFired).toBe(1);

    // Default 15-minute cooldown: identical ingest must not re-fire.
    const second = await ingest({ events: [{ type: "signup" }, { type: "signup" }] });
    expect((await second.json()).alertsFired).toBe(0);

    const events = await listAlertEvents(acmeTenantId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ruleId: rule.id, metric: "events", observed: 2, threshold: 2, delivered: false });
  });

  it("evaluates error_rate as errors/events*100 of the touched minute", async () => {
    await createRule({ name: "err-rate", metric: "error_rate", op: ">", threshold: 0, webhookUrl: "http://127.0.0.1:1/hook" });
    const res = await ingest({ events: [{ type: "error" }] });
    expect((await res.json()).alertsFired).toBeGreaterThanOrEqual(1);
  });

  it("does not evaluate disabled rules", async () => {
    const res = await createRule({ name: "off", metric: "events", op: ">=", threshold: 0, webhookUrl: "http://127.0.0.1:1/hook" });
    const { rule } = await res.json();
    await alertByIdRoute.PATCH(
      request(`/api/admin/alerts/${rule.id}`, sameOrigin({ method: "PATCH", cookie, body: JSON.stringify({ enabled: false }) })),
      { params: Promise.resolve({ id: rule.id }) },
    );
    const before = (await listAlertEvents(acmeTenantId)).length;
    await ingest({ events: [{ type: "signup" }] });
    expect((await listAlertEvents(acmeTenantId)).length).toBe(before);
  });
});

describe("alert delivery", () => {
  let sink: http.Server;
  let received: { headers: http.IncomingHttpHeaders; body: string }[];
  beforeAll(async () => {
    received = [];
    sink = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
  });
  afterAll(async () => {
    await new Promise((r) => sink.close(r));
  });

  it("posts the payload and marks the event delivered", async () => {
    const port = (sink.address() as AddressInfo).port;
    // The rule's own webhook is dead so the fire-and-forget delivery cannot
    // reach the sink; the explicit deliverAlert call below delivers to it.
    const res = await createRule({ name: "delivered", metric: "events", op: ">=", threshold: 1, webhookUrl: "http://127.0.0.1:1/hook", cooldownMinutes: 0 });
    const { rule } = await res.json();
    await ingest({ events: [{ type: "signup" }] });
    const evt = (await listAlertEvents(acmeTenantId)).find((e) => e.ruleId === rule.id);
    const fired: FiredAlert = {
      ruleId: rule.id,
      alertEventId: evt!.id,
      name: rule.name,
      metric: "events",
      op: ">=",
      threshold: 1,
      observed: 1,
      webhookUrl: `http://127.0.0.1:${port}/hook`,
    };
    await deliverAlert(acmeTenantId, fired);
    expect(received).toHaveLength(1);
    const payload = JSON.parse(received[0]!.body);
    expect(payload).toMatchObject({ type: "neuradash.alert", rule: "delivered", metric: "events" });
    const after = (await listAlertEvents(acmeTenantId)).find((e) => e.id === evt!.id);
    expect(after!.delivered).toBe(true);
  });

  it("marks undelivered when the webhook is unreachable", async () => {
    const res = await createRule({ name: "dead-end", metric: "events", op: ">=", threshold: 1, webhookUrl: "http://127.0.0.1:1/hook", cooldownMinutes: 0 });
    const { rule } = await res.json();
    await ingest({ events: [{ type: "signup" }] });
    const evt = (await listAlertEvents(acmeTenantId)).find((e) => e.ruleId === rule.id);
    await deliverAlert(acmeTenantId, {
      ruleId: rule.id, alertEventId: evt!.id, name: rule.name, metric: "events",
      op: ">=", threshold: 1, observed: 1, webhookUrl: rule.webhookUrl,
    });
    const after = (await listAlertEvents(acmeTenantId)).find((e) => e.id === evt!.id);
    expect(after!.delivered).toBe(false);
  });
});

afterAll(async () => {
  const client = appClient();
  await client.connect();
  await client.end();
});

describe("admin route validation", () => {
  const patchRule = (id: string, body: string) =>
    alertByIdRoute.PATCH(request(`/api/admin/alerts/${id}`, sameOrigin({ method: "PATCH", cookie, body })), {
      params: Promise.resolve({ id }),
    });

  it("returns 4xx, not 500, for malformed ids, empty or null patches and duplicate renames", async () => {
    const del = await alertByIdRoute.DELETE(request("/api/admin/alerts/nope", sameOrigin({ method: "DELETE", cookie })), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(del.status).toBe(404);
    expect((await patchRule("nope", JSON.stringify({ enabled: false }))).status).toBe(404);

    const a = await (await createRule({ name: "rename-a", metric: "events", op: ">", threshold: 1e9, webhookUrl: "http://127.0.0.1:1/a" })).json();
    await createRule({ name: "rename-b", metric: "events", op: ">", threshold: 1e9, webhookUrl: "http://127.0.0.1:1/b" });
    expect((await patchRule(a.rule.id, "{}")).status).toBe(422);
    expect((await patchRule(a.rule.id, "null")).status).toBe(422);
    expect((await patchRule(a.rule.id, JSON.stringify({ name: "rename-b" }))).status).toBe(409);
  });

  it("rejects null member payloads and uppercase self ids", async () => {
    const invite = await membersRoute.POST(request("/api/admin/members", sameOrigin({ method: "POST", cookie, body: "null" })));
    expect(invite.status).toBe(422);
    const [me] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, "admin@acme.test"));
    const upper = me!.id.toUpperCase();
    const demote = await memberRoute.PATCH(
      request(`/api/admin/members/${upper}`, sameOrigin({ method: "PATCH", cookie, body: JSON.stringify({ role: "viewer" }) })),
      { params: Promise.resolve({ id: upper }) },
    );
    expect(demote.status).toBe(422);
    const remove = await memberRoute.DELETE(request(`/api/admin/members/${upper}`, sameOrigin({ method: "DELETE", cookie })), {
      params: Promise.resolve({ id: upper }),
    });
    expect(remove.status).toBe(422);
  });

  it("fires a rule with a cooldown once per batch even when the batch spans several minutes", async () => {
    const res = await createRule({ name: "multi-minute", metric: "events", op: ">=", threshold: 1, webhookUrl: "http://127.0.0.1:1/m", cooldownMinutes: 15 });
    const { rule } = await res.json();
    const now = Date.now();
    const events = [0, 1, 2].map((m) => ({ type: "signup", occurredAt: new Date(now - m * 60_000 - 1_000).toISOString() }));
    expect((await ingest({ events })).status).toBe(202);
    const fired = (await listAlertEvents(acmeTenantId)).filter((e) => e.ruleId === rule.id);
    expect(fired).toHaveLength(1);
  });
});

describe("webhook destination guard", () => {
  it("refuses private destinations unless ALERT_WEBHOOK_ALLOW_PRIVATE=true", async () => {
    let calls = 0;
    const sink = http.createServer((_req, res) => {
      calls += 1;
      res.writeHead(200).end();
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    const port = (sink.address() as AddressInfo).port;
    const previous = process.env.ALERT_WEBHOOK_ALLOW_PRIVATE;
    try {
      const res = await createRule({
        name: "internal-hook", metric: "events", op: ">=", threshold: 1,
        webhookUrl: "http://127.0.0.1:1/hook", cooldownMinutes: 0,
      });
      const { rule } = await res.json();
      process.env.ALERT_WEBHOOK_ALLOW_PRIVATE = "false";
      await ingest({ events: [{ type: "signup" }] });
      const evt = (await listAlertEvents(acmeTenantId)).find((e) => e.ruleId === rule.id);
      await deliverAlert(acmeTenantId, {
        ruleId: rule.id, alertEventId: evt!.id, name: rule.name, metric: "events",
        op: ">=", threshold: 1, observed: 1, webhookUrl: `http://127.0.0.1:${port}/hook`,
      });
      expect(calls).toBe(0);
      const after = (await listAlertEvents(acmeTenantId)).find((e) => e.id === evt!.id);
      expect(after!.delivered).toBe(false);
    } finally {
      process.env.ALERT_WEBHOOK_ALLOW_PRIVATE = previous;
      await new Promise((r) => sink.close(r));
    }
  });
});

describe("alert delivery retries", () => {
  it("retries a failed delivery on sweep and marks it delivered", async () => {
    // Webhook that fails the first request then accepts.
    let calls = 0;
    const flaky = http.createServer((_req, res) => {
      calls += 1;
      res.writeHead(calls < 2 ? 500 : 200).end();
    });
    await new Promise<void>((r) => flaky.listen(0, "127.0.0.1", r));
    const port = (flaky.address() as AddressInfo).port;
    try {
      const res = await createRule({
        name: "flaky-hook", metric: "events", op: ">=", threshold: 1,
        webhookUrl: `http://127.0.0.1:${port}/hook`, cooldownMinutes: 0,
      });
      const { rule } = await res.json();
      await ingest({ events: [{ type: "signup" }] });
      // The ingest route's fire-and-forget delivery consumes the 500; wait for it
      // to record attempt 1 with a scheduled retry.
      let evt;
      for (let i = 0; i < 40; i++) {
        // Other rules from earlier tests can fire on the same ingest, so match by rule id.
        evt = (await listAlertEvents(acmeTenantId)).find((e) => e.ruleId === rule.id);
        if (evt && evt.attempts >= 1) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(evt?.attempts).toBe(1);
      expect(evt?.delivered).toBe(false);
      expect(evt?.nextAttemptAt).toBeTruthy();

      // Make the retry due and sweep: flaky now returns 200.
      const client = appClient();
      await client.connect();
      try {
        await client.query("begin");
        await client.query("select set_config('app.tenant_id', $1, true)", [acmeTenantId]);
        await client.query(
          "update alert_events set next_attempt_at = now() - interval '1 second' where id = $1",
          [evt!.id],
        );
        await client.query("commit");
      } finally {
        await client.end();
      }
      expect(await sweepAlertRetries()).toBeGreaterThanOrEqual(1);
      const after = (await listAlertEvents(acmeTenantId)).find((e) => e.id === evt!.id);
      expect(after!).toMatchObject({ id: evt!.id, delivered: true, attempts: 2 });
      expect(after!.nextAttemptAt).toBeNull();
      expect(calls).toBe(2);
    } finally {
      await new Promise((r) => flaky.close(r));
    }
  });

  it("dead-letters an event after the attempt cap", async () => {
    const res = await createRule({
      name: "always-dead", metric: "events", op: ">=", threshold: 1,
      webhookUrl: "http://127.0.0.1:1/hook", cooldownMinutes: 0,
    });
    const { rule } = await res.json();
    await ingest({ events: [{ type: "signup" }] });
    let evt;
    for (let i = 0; i < 40; i++) {
      const events = await listAlertEvents(acmeTenantId, 10);
      evt = events.find((e) => e.ruleId === rule.id);
      if (evt && evt.attempts >= 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const client = appClient();
    await client.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [acmeTenantId]);
      await client.query(
        "update alert_events set attempts = 4, next_attempt_at = now() - interval '1 second' where id = $1",
        [evt!.id],
      );
      await client.query("commit");
    } finally {
      await client.end();
    }
    await sweepAlertRetries();
    const events = await listAlertEvents(acmeTenantId, 10);
    const after = events.find((e) => e.id === evt!.id)!;
    expect(after.attempts).toBe(5);
    expect(after.delivered).toBe(false);
    expect(after!.nextAttemptAt).toBeNull();
  });
});
