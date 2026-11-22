import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("a viewer cannot reach admin actions", async ({ page, baseURL }) => {
  await login(page, "viewer@acme.test");
  await expect(page.getByTestId("user-role")).toHaveText("viewer");
  await expect(page.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: /403/ })).toBeVisible();
  await expect(page.getByLabel("Key name")).toHaveCount(0);

  const create = await page.request.post("/api/admin/api-keys", { headers: { origin: baseURL! }, data: { name: "x" } });
  expect(create.status()).toBe(403);
  expect((await page.request.get("/api/admin/api-keys")).status()).toBe(403);
});

test("an admin creates an API key, uses it, and revokes it", async ({ page }) => {
  await login(page, "admin@acme.test");
  await page.getByRole("link", { name: "Admin", exact: true }).click();
  await page.getByLabel("Key name").fill("e2e key");
  await page.getByRole("button", { name: "Create key" }).click();
  const key = (await page.getByTestId("new-api-key").textContent())!;
  expect(key).toMatch(/^nd_[0-9a-f]{40}$/);

  const ok = await page.request.post("/api/ingest", { headers: { authorization: `Bearer ${key}` }, data: { type: "e2e" } });
  expect(ok.status()).toBe(202);

  const row = page.getByTestId("api-key-row").filter({ hasText: "e2e key" });
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toContainText("revoked");
  const denied = await page.request.post("/api/ingest", { headers: { authorization: `Bearer ${key}` }, data: { type: "e2e" } });
  expect(denied.status()).toBe(401);
});
