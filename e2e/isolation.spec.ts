import { expect, test } from "@playwright/test";
import { GLOBEX_KEY, ingest, login, uniqueSource } from "./helpers";

test("an Acme user cannot read a Globex event over HTTP", async ({ page }) => {
  await login(page, "admin@acme.test");
  const { ids } = await ingest(page.request, GLOBEX_KEY, { type: "signup", source: uniqueSource("globex-secret") });

  const direct = await page.request.get(`/api/events/${ids[0]}`);
  expect(direct.status()).toBe(404);

  const list = await page.request.get("/api/events?limit=200&tenant=globex");
  const { events } = (await list.json()) as { events: { id: number }[] };
  expect(events.map((e) => e.id)).not.toContain(ids[0]);

  await expect(page.locator(`[data-event-id="${ids[0]}"]`)).toHaveCount(0);
});

test("the WebSocket channel is bound to the session tenant", async ({ page }) => {
  await login(page, "admin@globex.test");
  await expect(page.getByTestId("tenant-name")).toHaveText("Globex Labs");
  const ready = await page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const ws = new WebSocket(`${location.origin.replace("http", "ws")}/ws?tenant=acme`);
        ws.onmessage = (m) => {
          resolve(JSON.parse(m.data));
          ws.close();
        };
        ws.onerror = () => reject(new Error("ws error"));
      }),
  );
  expect(ready).toMatchObject({ type: "ready", tenant: "globex" });
});

test("a WebSocket without a session is rejected", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${baseURL}/login`);
  const outcome = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`${location.origin.replace("http", "ws")}/ws`);
        ws.onopen = () => resolve("open");
        ws.onclose = () => resolve("closed");
      }),
  );
  expect(outcome).toBe("closed");
  await context.close();
});
