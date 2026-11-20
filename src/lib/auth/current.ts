import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession, SESSION_COOKIE, type Session } from "./session";

/** Session for the current server-component request, or a redirect to /login. */
export async function requirePageSession(): Promise<Session> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await getSession(token);
  if (!session) redirect("/login");
  return session;
}

export async function currentSession(): Promise<Session | null> {
  return getSession((await cookies()).get(SESSION_COOKIE)?.value);
}
