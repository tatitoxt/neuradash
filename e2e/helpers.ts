import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const DEMO_PASSWORD = "neuradash-demo";
export const ACME_KEY = "nd_demo_acme_local_only_0000000000000000";
export const GLOBEX_KEY = "nd_demo_globex_local_only_00000000000000";

export async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

export async function ingest(request: APIRequestContext, apiKey: string, event: Record<string, unknown>) {
  const res = await request.post("/api/ingest", { headers: { authorization: `Bearer ${apiKey}` }, data: event });
  expect(res.status()).toBe(202);
  return (await res.json()) as { accepted: number; ids: number[] };
}

export function uniqueSource(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
