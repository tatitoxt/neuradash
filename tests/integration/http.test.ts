import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as loginRoute from "@/app/api/auth/login/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import * as meRoute from "@/app/api/me/route";
import * as ingestRoute from "@/app/api/ingest/route";
import * as eventsRoute from "@/app/api/events/route";
import * as eventRoute from "@/app/api/events/[id]/route";
import * as metricsRoute from "@/app/api/metrics/route";
import * as keysRoute from "@/app/api/admin/api-keys/route";
import * as keyRoute from "@/app/api/admin/api-keys/[id]/route";
import { DEMO_PASSWORD } from "@/lib/seed";
import { closeDb } from "@/lib/db/client";
import { cookieFrom, request, reseed, sameOrigin } from "./helpers";

let seeded: Awaited<ReturnType<typeof reseed>>;
const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

async function loginAs(email: string): Promise<string> {
  const res = await loginRoute.POST(
    request("/api/auth/login", sameOrigin({ method: "POST", body: JSON.stringify({ email, password: DEMO_PASSWORD }) })),
  );
  expect(res.status).toBe(200);
  return cookieFrom(res);
}

async function ingest(apiKey: string, body: unknown) {
  return ingestRoute.POST(
    request("/api/ingest", { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) }),
  );
}

let acmeAdmin: string;
let acmeViewer: string;
let globexAdmin: string;

beforeAll(async () => {
  seeded = await reseed(30);
  [acmeAdmin, acmeViewer, globexAdmin] = await Promise.all([
    loginAs("admin@acme.test"),
    loginAs("viewer@acme.test"),
    loginAs("admin@globex.test"),
  ]);
});
afterAll(() => closeDb());

describe("login and sessions", () => {
  it("rejects a wrong password with a generic error", async () => {
    const res = await loginRoute.POST(
      request("/api/auth/login", sameOrigin({ method: "POST", body: JSON.stringify({ email: "admin@acme.test", password: "nope" }) })),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_credentials" });
  });

  it("rejects cross-origin login attempts", async () => {
    const res = await loginRoute.POST(
      request("/api/auth/login", {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: JSON.stringify({ email: "admin@acme.test", password: DEMO_PASSWORD }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("issues an HttpOnly session cookie and resolves role from the membership", async () => {
    const me = await meRoute.GET(request("/api/me", { cookie: acmeViewer }));
    expect(await me.json()).toMatchObject({ email: "viewer@acme.test", tenant: { slug: "acme" }, role: "viewer" });
    const res = await loginRoute.POST(
      request("/api/auth/login", sameOrigin({ method: "POST", body: JSON.stringify({ email: "admin@globex.test", password: DEMO_PASSWORD }) })),
    );
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/);
  });

  it("requires a session for data endpoints", async () => {
    expect((await metricsRoute.GET(request("/api/metrics"))).status).toBe(401);
    expect((await eventsRoute.GET(request("/api/events", { cookie: "nd_session=forged" }))).status).toBe(401);
  });

  it("invalidates the session on logout", async () => {
    const cookie = await loginAs("viewer@acme.test");
    const out = await logoutRoute.POST(request("/api/auth/logout", sameOrigin({ method: "POST", cookie })));
    expect(out.status).toBe(200);
    expect((await meRoute.GET(request("/api/me", { cookie }))).status).toBe(401);
  });
});

describe("ingest", () => {
  it("requires a valid API key", async () => {
    expect((await ingestRoute.POST(request("/api/ingest", { method: "POST", body: "{}" }))).status).toBe(401);
    expect((await ingest("nd_not_a_real_key", { type: "x" })).status).toBe(401);
  });

  it("validates the payload", async () => {
    expect((await ingest(seeded.acme!.apiKey, { type: "bad type" })).status).toBe(422);
    expect((await ingest(seeded.acme!.apiKey, { type: "x", tenantId: seeded.globex!.tenantId })).status).toBe(422);
  });

  it("persists events for the key's tenant", async () => {
    const res = await ingest(seeded.acme!.apiKey, { events: [{ type: "purchase", source: "test", value: 9.5 }, { type: "signup" }] });
    expect(res.status).toBe(202);
    const { accepted, ids } = (await res.json()) as { accepted: number; ids: number[] };
    expect(accepted).toBe(2);
    const read = await eventRoute.GET(request(`/api/events/${ids[0]}`, { cookie: acmeAdmin }), params(ids[0]!));
    expect(await read.json()).toMatchObject({ event: { id: ids[0], type: "purchase", value: 9.5 } });
  });
});

describe("cross-tenant isolation over HTTP", () => {
  it("tenant A cannot read tenant B's event by id", async () => {
    const res = await ingest(seeded.globex!.apiKey, { type: "signup", source: "globex-secret" });
    const { ids } = (await res.json()) as { ids: number[] };
    const asAcme = await eventRoute.GET(request(`/api/events/${ids[0]}`, { cookie: acmeAdmin }), params(ids[0]!));
    expect(asAcme.status).toBe(404);
    const asGlobex = await eventRoute.GET(request(`/api/events/${ids[0]}`, { cookie: globexAdmin }), params(ids[0]!));
    expect(asGlobex.status).toBe(200);
  });

  it("event lists and metrics only include the session's tenant", async () => {
    await ingest(seeded.globex!.apiKey, { type: "signup", source: "globex-only-source" });
    const list = (await (await eventsRoute.GET(request("/api/events?limit=200", { cookie: acmeAdmin }))).json()) as {
      events: { source: string }[];
    };
    expect(list.events.length).toBeGreaterThan(0);
    expect(list.events.some((e) => e.source.startsWith("globex"))).toBe(false);

    const m = (await (await metricsRoute.GET(request("/api/metrics?range=7d", { cookie: acmeAdmin }))).json()) as {
      sourceNames: string[];
    };
    expect(m.sourceNames).not.toContain("globex-only-source");
  });

  it("ignores tenant hints in query strings", async () => {
    const res = await eventsRoute.GET(
      request(`/api/events?tenant=globex&tenantId=${seeded.globex!.tenantId}`, { cookie: acmeAdmin }),
    );
    const { events } = (await res.json()) as { events: { source: string }[] };
    expect(events.some((e) => e.source.startsWith("globex"))).toBe(false);
  });

  it("an admin cannot revoke another tenant's API key", async () => {
    const globexKeys = (await (await keysRoute.GET(request("/api/admin/api-keys", { cookie: globexAdmin }))).json()) as {
      apiKeys: { id: string }[];
    };
    const target = globexKeys.apiKeys[0]!.id;
    const res = await keyRoute.DELETE(request(`/api/admin/api-keys/${target}`, sameOrigin({ method: "DELETE", cookie: acmeAdmin })), params(target));
    expect(res.status).toBe(404);
    expect((await ingest(seeded.globex!.apiKey, { type: "still_works" })).status).toBe(202);
  });
});

describe("roles", () => {
  it("a viewer cannot list, create or revoke API keys", async () => {
    expect((await keysRoute.GET(request("/api/admin/api-keys", { cookie: acmeViewer }))).status).toBe(403);
    const create = await keysRoute.POST(
      request("/api/admin/api-keys", sameOrigin({ method: "POST", cookie: acmeViewer, body: JSON.stringify({ name: "x" }) })),
    );
    expect(create.status).toBe(403);
    const id = "00000000-0000-4000-8000-000000000000";
    const del = await keyRoute.DELETE(request(`/api/admin/api-keys/${id}`, sameOrigin({ method: "DELETE", cookie: acmeViewer })), params(id));
    expect(del.status).toBe(403);
  });

  it("an admin can create a key, ingest with it, and revoke it", async () => {
    const create = await keysRoute.POST(
      request("/api/admin/api-keys", sameOrigin({ method: "POST", cookie: acmeAdmin, body: JSON.stringify({ name: "ci" }) })),
    );
    expect(create.status).toBe(201);
    const { apiKey, key } = (await create.json()) as { apiKey: { id: string }; key: string };
    expect((await ingest(key, { type: "from_new_key" })).status).toBe(202);

    const list = (await (await keysRoute.GET(request("/api/admin/api-keys", { cookie: acmeAdmin }))).json()) as {
      apiKeys: Record<string, unknown>[];
    };
    expect(JSON.stringify(list)).not.toContain(key);

    const del = await keyRoute.DELETE(
      request(`/api/admin/api-keys/${apiKey.id}`, sameOrigin({ method: "DELETE", cookie: acmeAdmin })),
      params(apiKey.id),
    );
    expect(del.status).toBe(204);
    expect((await ingest(key, { type: "after_revoke" })).status).toBe(401);
  });

  it("rejects cookie-authenticated mutations without a same-origin Origin header", async () => {
    const res = await keysRoute.POST(
      request("/api/admin/api-keys", { method: "POST", cookie: acmeAdmin, body: JSON.stringify({ name: "csrf" }) }),
    );
    expect(res.status).toBe(403);
  });
});
