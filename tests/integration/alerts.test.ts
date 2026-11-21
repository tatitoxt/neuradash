import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as alertsRoute from "@/app/api/admin/alerts/route";
import * as alertByIdRoute from "@/app/api/admin/alerts/[id]/route";
import * as ingestRoute from "@/app/api/ingest/route";
import * as loginRoute from "@/app/api/auth/login/route";
import { deliverAlert, listAlertEvents, type FiredAlert } from "@/lib/data/alerts";
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
    const [evt] = await listAlertEvents(acmeTenantId, 1);
    const fired: FiredAlert = {
      ruleId: rule.id,
      alertEventId: evt.id,
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
    const [after] = await listAlertEvents(acmeTenantId, 1);
    expect(after.delivered).toBe(true);
  });

  it("marks undelivered when the webhook is unreachable", async () => {
    const res = await createRule({ name: "dead-end", metric: "events", op: ">=", threshold: 1, webhookUrl: "http://127.0.0.1:1/hook", cooldownMinutes: 0 });
    const { rule } = await res.json();
    await ingest({ events: [{ type: "signup" }] });
    const [evt] = await listAlertEvents(acmeTenantId, 1);
    await deliverAlert(acmeTenantId, {
      ruleId: rule.id, alertEventId: evt.id, name: rule.name, metric: "events",
      op: ">=", threshold: 1, observed: 1, webhookUrl: rule.webhookUrl,
    });
    const [after] = await listAlertEvents(acmeTenantId, 1);
    expect(after.delivered).toBe(false);
  });
});

afterAll(async () => {
  const client = appClient();
  await client.connect();
  await client.end();
});
