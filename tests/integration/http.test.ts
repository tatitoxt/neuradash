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
import * as membersRoute from "@/app/api/admin/members/route";
import * as memberRoute from "@/app/api/admin/members/[id]/route";
import * as switchRoute from "@/app/api/auth/switch-tenant/route";
import * as retentionRoute from "@/app/api/admin/retention/route";
import * as pruneRoute from "@/app/api/admin/retention/prune/route";
import { DEMO_PASSWORD } from "@/lib/seed";
import { createApiKey } from "@/lib/data/api-keys";
import { closeDb } from "@/lib/db/client";
import { appClient, cookieFrom, request, reseed, sameOrigin } from "./helpers";

let seeded: Awaited<ReturnType<typeof reseed>>;
const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

async function loginAs(email: string, password = DEMO_PASSWORD): Promise<string> {
  const res = await loginRoute.POST(
    request("/api/auth/login", sameOrigin({ method: "POST", body: JSON.stringify({ email, password }) })),
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

  it("rate-limits repeated login failures across the shared Postgres bucket", async () => {
    // A non-existent mailbox keeps the bucket isolated from real users.
    const email = `ghost-${Date.now()}@acme.test`;
    const tryLogin = () =>
      loginRoute.POST(
        request("/api/auth/login", sameOrigin({ method: "POST", body: JSON.stringify({ email, password: "nope" }) })),
      );
    for (let i = 0; i < 10; i += 1) {
      const res = await tryLogin();
      expect(res.status).toBe(401);
    }
    const blocked = await tryLogin();
    expect(blocked.status).toBe(429);

    // reset_login_attempts clears the bucket for the next window.
    const client = appClient();
    await client.connect();
    try {
      await client.query("select reset_login_attempts($1)", [email]);
    } finally {
      await client.end();
    }
    expect((await tryLogin()).status).toBe(401);
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

  it("rejects expired keys and keys without the ingest scope", async () => {
    const tenantId = seeded.acme!.tenantId;
    const expired = await createApiKey(tenantId, "expired", { expiresAt: new Date(Date.now() - 60_000) });
    expect((await ingest(expired.key, { type: "x" })).status).toBe(401);

    const noScope = await createApiKey(tenantId, "no-ingest", { scopes: [] });
    expect((await ingest(noScope.key, { type: "x" })).status).toBe(403);
    expect(await (await ingest(noScope.key, { type: "x" })).json()).toMatchObject({ error: "insufficient_scope" });
  });

  it("enforces the key's per-minute ingest limit only on that key", async () => {
    const tenantId = seeded.acme!.tenantId;
    const limited = await createApiKey(tenantId, "limited", { rateLimitPerMinute: 2 });
    expect(limited.apiKey.rateLimitPerMinute).toBe(2);
    expect((await ingest(limited.key, { type: "x" })).status).toBe(202);
    expect((await ingest(limited.key, { type: "x" })).status).toBe(202);
    const third = await ingest(limited.key, { type: "x" });
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: "rate_limited" });

    // An unlimited key of the same tenant is unaffected.
    const open = await createApiKey(tenantId, "unlimited");
    expect((await ingest(open.key, { type: "x" })).status).toBe(202);
  });
});

describe("event listing", () => {
  it("accepts fractional limits", async () => {
    const res = await eventsRoute.GET(request("/api/events?limit=2.5", { cookie: acmeAdmin }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { events: unknown[] }).events).toHaveLength(2);
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

describe("tenant switching", () => {
  it("lets a multi-tenant user switch and resolves the role per tenant", async () => {
    const cookie = await loginAs("multi@demo.test");
    const me = await meRoute.GET(request("/api/me", { cookie }));
    expect(me.status).toBe(200);
    const meBody = await me.json();
    expect(meBody.tenant.slug).toBe("acme");
    expect(meBody.tenants).toHaveLength(2);

    const res = await switchRoute.POST(
      request("/api/auth/switch-tenant", sameOrigin({ method: "POST", cookie, body: JSON.stringify({ tenant: "globex" }) })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tenant: { slug: "globex" }, role: "viewer" });

    const me2 = await meRoute.GET(request("/api/me", { cookie }));
    expect((await me2.json()).tenant.slug).toBe("globex");
  });

  it("rejects a tenant the user does not belong to", async () => {
    const res = await switchRoute.POST(
      request("/api/auth/switch-tenant", sameOrigin({ method: "POST", cookie: acmeViewer, body: JSON.stringify({ tenant: "globex" }) })),
    );
    expect(res.status).toBe(403);
  });

  it("rejects cross-origin switches", async () => {
    const res = await switchRoute.POST(
      request("/api/auth/switch-tenant", {
        method: "POST",
        headers: { origin: "https://evil.example" },
        cookie: acmeAdmin,
        body: JSON.stringify({ tenant: "acme" }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

let newbieCookie: string;

describe("member administration", () => {
  it("requires admin for list and mutations", async () => {
    expect((await membersRoute.GET(request("/api/admin/members", { cookie: acmeViewer }))).status).toBe(403);
    const res = await membersRoute.POST(
      request("/api/admin/members", sameOrigin({ method: "POST", cookie: acmeViewer, body: JSON.stringify({ email: "x@y.test", role: "viewer" }) })),
    );
    expect(res.status).toBe(403);
  });

  it("invites a new user who can log in with the temporary password", async () => {
    const res = await membersRoute.POST(
      request("/api/admin/members", sameOrigin({ method: "POST", cookie: acmeAdmin, body: JSON.stringify({ email: "newbie@acme.test", name: "Nia Newbie", role: "viewer" }) })),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.member).toMatchObject({ email: "newbie@acme.test", role: "viewer" });
    expect(typeof body.temporaryPassword).toBe("string");

    const login = await loginRoute.POST(
      request("/api/auth/login", sameOrigin({ method: "POST", body: JSON.stringify({ email: "newbie@acme.test", password: body.temporaryPassword }) })),
    );
    expect(login.status).toBe(200);
    newbieCookie = cookieFrom(login);
  });

  it("returns 409 for an existing member and 422 for bad input", async () => {
    const dupe = await membersRoute.POST(
      request("/api/admin/members", sameOrigin({ method: "POST", cookie: acmeAdmin, body: JSON.stringify({ email: "newbie@acme.test", role: "viewer" }) })),
    );
    expect(dupe.status).toBe(409);
    const bad = await membersRoute.POST(
      request("/api/admin/members", sameOrigin({ method: "POST", cookie: acmeAdmin, body: JSON.stringify({ email: "other@acme.test", role: "owner" }) })),
    );
    expect(bad.status).toBe(422);
  });

  it("promotes a member and the new role applies immediately", async () => {
    const list = await membersRoute.GET(request("/api/admin/members", { cookie: acmeAdmin }));
    const members = (await list.json()).members as { userId: string; email: string }[];
    const newbie = members.find((m) => m.email === "newbie@acme.test")!;

    const before = await meRoute.GET(request("/api/me", { cookie: acmeViewer }));
    expect((await before.json()).role).toBe("viewer");
    const viewer = members.find((m) => m.email === "viewer@acme.test")!;

    const patch = await memberRoute.PATCH(
      request(`/api/admin/members/${viewer.userId}`, sameOrigin({ method: "PATCH", cookie: acmeAdmin, body: JSON.stringify({ role: "admin" }) })),
      params(viewer.userId),
    );
    expect(patch.status).toBe(200);
    // Role is re-read from memberships on every request — the live session upgrades now.
    const after = await meRoute.GET(request("/api/me", { cookie: acmeViewer }));
    expect((await after.json()).role).toBe("admin");
    expect(newbie.userId).toBeTruthy();
  });

  it("blocks self-changes and removes a member, killing their session", async () => {
    const list = await membersRoute.GET(request("/api/admin/members", { cookie: acmeAdmin }));
    const members = (await list.json()).members as { userId: string; email: string }[];
    const self = members.find((m) => m.email === "admin@acme.test")!;
    const newbie = members.find((m) => m.email === "newbie@acme.test")!;

    const selfPatch = await memberRoute.PATCH(
      request(`/api/admin/members/${self.userId}`, sameOrigin({ method: "PATCH", cookie: acmeAdmin, body: JSON.stringify({ role: "viewer" }) })),
      params(self.userId),
    );
    expect(selfPatch.status).toBe(422);
    const selfDelete = await memberRoute.DELETE(
      request(`/api/admin/members/${self.userId}`, sameOrigin({ method: "DELETE", cookie: acmeAdmin })),
      params(self.userId),
    );
    expect(selfDelete.status).toBe(422);

    const del = await memberRoute.DELETE(
      request(`/api/admin/members/${newbie.userId}`, sameOrigin({ method: "DELETE", cookie: acmeAdmin })),
      params(newbie.userId),
    );
    expect(del.status).toBe(204);
    const delAgain = await memberRoute.DELETE(
      request(`/api/admin/members/${newbie.userId}`, sameOrigin({ method: "DELETE", cookie: acmeAdmin })),
      params(newbie.userId),
    );
    expect(delAgain.status).toBe(404);
    // Removing the membership killed the member's sessions in this tenant.
    const me = await meRoute.GET(request("/api/me", { cookie: newbieCookie }));
    expect(me.status).toBe(401);
  });
});


describe("event retention", () => {
  it("prunes events past the tenant's retention window", async () => {
    const admin = acmeAdmin;
    // viewer@acme.test is promoted to admin by the member-administration
    // suite, so the RBAC check uses a dedicated invitee instead.
    const invite = await membersRoute.POST(
      request("/api/admin/members",
        sameOrigin({ method: "POST", cookie: admin, body: JSON.stringify({ email: "retention.viewer@acme.test", role: "viewer" }) })));
    const { temporaryPassword } = (await invite.json()) as { temporaryPassword: string };
    const viewer = await loginAs("retention.viewer@acme.test", temporaryPassword);
    const tid = seeded.acme!.tenantId;

    // RBAC + validation.
    expect(
      (await retentionRoute.PUT(request("/api/admin/retention",
        sameOrigin({ method: "PUT", cookie: viewer, body: JSON.stringify({ retentionDays: 1 }) })))).status,
    ).toBe(403);
    expect(
      (await retentionRoute.PUT(request("/api/admin/retention",
        sameOrigin({ method: "PUT", cookie: admin, body: JSON.stringify({ retentionDays: 0 }) })))).status,
    ).toBe(422);

    // Set a 1-day window, plant an old and a fresh event, then prune.
    expect(
      (await retentionRoute.PUT(request("/api/admin/retention",
        sameOrigin({ method: "PUT", cookie: admin, body: JSON.stringify({ retentionDays: 1 }) })))).status,
    ).toBe(200);
    const cur = await retentionRoute.GET(request("/api/admin/retention", { cookie: admin }));
    expect((await cur.json()).retentionDays).toBe(1);

    const client = appClient();
    await client.connect();
    try {
      await client.query("select set_config('app.tenant_id', $1, false)", [tid]);
      await client.query(
        `insert into events (tenant_id, type, source, occurred_at, received_at)
         values ($1, 'old_evt', 'test', now() - interval '3 days', now() - interval '3 days')`,
        [tid],
      );
      await client.query(
        `insert into events (tenant_id, type, source, occurred_at, received_at)
         values ($1, 'fresh_evt', 'test', now(), now())`,
        [tid],
      );
      const pruned = await pruneRoute.POST(request("/api/admin/retention/prune",
        sameOrigin({ method: "POST", cookie: admin })));
      expect(pruned.status).toBe(200);
      expect((await pruned.json()).deleted).toBeGreaterThanOrEqual(1);

      const old = await client.query("select count(*)::int n from events where type = 'old_evt'", []);
      const fresh = await client.query("select count(*)::int n from events where type = 'fresh_evt'", []);
      expect(old.rows[0].n).toBe(0);
      expect(fresh.rows[0].n).toBe(1);
      // Rollups keep the aggregates even after the raw events are pruned.
      const rollups = await client.query(
        "select count(*)::int n from metric_rollups where tenant_id = $1", [tid]);
      expect(rollups.rows[0].n).toBeGreaterThan(0);
    } finally {
      await client.end();
    }

    // Null disables retention again.
    await retentionRoute.PUT(request("/api/admin/retention",
      sameOrigin({ method: "PUT", cookie: admin, body: JSON.stringify({ retentionDays: null }) })));
  });
});
