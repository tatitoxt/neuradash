import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await getDb().execute(sql`select 1`);
    return json({ status: "ok" });
  } catch {
    return json({ status: "degraded", database: "unreachable" }, 503);
  }
}
