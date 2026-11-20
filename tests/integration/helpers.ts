import pg from "pg";
import { seedDemo } from "@/lib/seed";

export const ORIGIN = "http://localhost:3000";
export const FAST_SCRYPT = { N: 1024, r: 8, p: 1 };

export async function reseed(eventsPerTenant = 50) {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_OWNER_URL });
  try {
    return await seedDemo(owner, { eventsPerTenant, scrypt: FAST_SCRYPT });
  } finally {
    await owner.end();
  }
}

export function appClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.DATABASE_URL });
}

export function request(path: string, init: RequestInit & { cookie?: string } = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", "localhost:3000");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(new URL(path, ORIGIN), { ...init, headers });
}

export function sameOrigin(init: RequestInit & { cookie?: string } = {}) {
  return { ...init, headers: { origin: ORIGIN, ...(init.headers as Record<string, string>) } };
}

export function cookieFrom(res: Response): string {
  const header = res.headers.get("set-cookie");
  if (!header) throw new Error("no set-cookie header");
  return header.split(";")[0]!;
}
