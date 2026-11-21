import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

/**
 * Login brute-force limiter, shared across app instances. The counters live in
 * Postgres (auth_rate_windows) and are updated by the SECURITY DEFINER
 * functions consume_login_attempt / reset_login_attempts — an atomic upsert
 * per attempt, so two instances can't both under-count the same burst.
 */

const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_SECONDS = 5 * 60;

/** Records an attempt; returns false once the bucket passed the limit this window. */
export async function consumeLoginAttempt(email: string): Promise<boolean> {
  const result = await getDb().execute<{ allowed: boolean }>(
    sql`select consume_login_attempt(${email}, ${LOGIN_LIMIT}, ${LOGIN_WINDOW_SECONDS}) as allowed`,
  );
  return result.rows[0]?.allowed ?? true;
}

/** Clears the bucket after a successful login. */
export async function resetLoginAttempts(email: string): Promise<void> {
  await getDb().execute(sql`select reset_login_attempts(${email})`);
}
