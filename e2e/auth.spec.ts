import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("unauthenticated visitors are sent to the login page", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Sign in to NeuraDash" })).toBeVisible();
});

test("wrong password shows an error and does not sign in", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@acme.test");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/invalid email or password/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("admin logs in and sees the tenant dashboard", async ({ page }) => {
  await login(page, "admin@acme.test");
  await expect(page.getByTestId("tenant-name")).toHaveText("Acme Robotics");
  await expect(page.getByTestId("user-role")).toHaveText("admin");
  for (const kpi of ["events", "error-rate", "revenue", "sources"]) {
    await expect(page.getByTestId(`kpi-${kpi}`)).toBeVisible();
  }
  await expect(page.getByTestId("chart-volume")).toBeVisible();
  await expect(page.getByTestId("feed-item").first()).toBeVisible();
  await expect(page.getByTestId("live-status")).toHaveText("live");
});

test("time-range filter changes the window", async ({ page }) => {
  await login(page, "admin@acme.test");
  await page.getByRole("link", { name: "7d" }).click();
  await expect(page).toHaveURL(/range=7d/);
  await expect(page.getByRole("heading", { name: "Last 7 days" })).toBeVisible();
  const weekly = Number((await page.getByTestId("kpi-events-value").textContent())!.replace(/,/g, ""));
  await page.getByRole("link", { name: "15m" }).click();
  await expect(page.getByRole("heading", { name: "Last 15 min" })).toBeVisible();
  const recent = Number((await page.getByTestId("kpi-events-value").textContent())!.replace(/,/g, ""));
  expect(weekly).toBeGreaterThan(recent);
});

test("logout ends the session", async ({ page }) => {
  await login(page, "viewer@acme.test");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  expect((await page.request.get("/api/me")).status()).toBe(401);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});
