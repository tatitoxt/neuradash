import { expect, test, type WebSocketRoute } from "@playwright/test";
import { ACME_KEY, GLOBEX_KEY, ingest, login, uniqueSource } from "./helpers";

test("an ingested event appears live without reloading, and other tenants' events do not", async ({ page }) => {
  await login(page, "admin@acme.test");
  await page.getByRole("link", { name: "15m" }).click();
  // Wait for the 15m dashboard to replace the default one before reading its KPI.
  await expect(page.getByRole("heading", { name: "Last 15 min" })).toBeVisible();
  await expect(page.getByTestId("live-status")).toHaveText("live");
  const eventsBefore = Number((await page.getByTestId("kpi-events-value").textContent())!.replace(/,/g, ""));

  const globexSource = uniqueSource("globex-e2e");
  const acmeSource = uniqueSource("acme-e2e");
  await ingest(page.request, GLOBEX_KEY, { type: "signup", source: globexSource });
  const { ids } = await ingest(page.request, ACME_KEY, { type: "purchase", source: acmeSource, value: 42 });

  const item = page.locator(`[data-testid="feed-item"][data-event-id="${ids[0]}"]`);
  await expect(item).toContainText(acmeSource);
  await expect(page.getByTestId("kpi-events-value")).toHaveText((eventsBefore + 1).toLocaleString("en-US"));
  await expect(page.getByTestId("live-feed")).not.toContainText(globexSource);
});

test("events missed while the socket was down are backfilled on reconnect", async ({ page }) => {
  // Intercept the dashboard's WebSocket so the test controls when it drops and when it may reconnect.
  let connections = 0;
  let release!: () => void;
  const reconnectAllowed = new Promise<void>((r) => (release = r));
  const routes: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws$/, async (ws) => {
    connections += 1;
    routes.push(ws);
    if (connections === 1) {
      ws.connectToServer();
      return;
    }
    // Hold the reconnect (and its resume message) until the missed event exists.
    const buffered: (string | Buffer)[] = [];
    let server: WebSocketRoute | null = null;
    ws.onMessage((m) => (server ? server.send(m) : buffered.push(m)));
    await reconnectAllowed;
    server = ws.connectToServer();
    for (const m of buffered) server.send(m);
  });

  await login(page, "admin@acme.test");
  await expect(page.getByTestId("live-status")).toHaveText("live");

  await routes[0]!.close();
  await expect(page.getByTestId("live-status")).not.toHaveText("live");

  const source = uniqueSource("acme-missed");
  const { ids } = await ingest(page.request, ACME_KEY, { type: "signup", source });
  release();

  await expect(page.locator(`[data-testid="feed-item"][data-event-id="${ids[0]}"]`)).toContainText(source);
  await expect(page.getByTestId("live-status")).toHaveText("live");
  expect(connections).toBe(2);
});
