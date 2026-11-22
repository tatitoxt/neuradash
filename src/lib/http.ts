import { getSession, SESSION_COOKIE, type Session } from "@/lib/auth/session";
import type { Role } from "@/lib/db/schema";

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function apiError(status: number, error: string, message?: string): Response {
  return json({ error, ...(message ? { message } : {}) }, status);
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key || key in out) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Malformed percent-encoding: ignore this cookie rather than fail the request.
    }
  }
  return out;
}

export function sessionTokenFrom(headers: Headers | { cookie?: string | undefined }): string | undefined {
  const cookie = headers instanceof Headers ? headers.get("cookie") : headers.cookie;
  return parseCookies(cookie)[SESSION_COOKIE];
}

/**
 * CSRF defence for cookie-authenticated mutations: the browser-supplied Origin must match
 * the Host the request was sent to. Combined with SameSite=Lax session cookies.
 */
export function isSameOrigin(headers: Headers | { origin?: string | undefined; host?: string | undefined }): boolean {
  const get = (name: "origin" | "host") => (headers instanceof Headers ? headers.get(name) : headers[name]) ?? null;
  const origin = get("origin");
  const host = get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

type Guard = { ok: true; session: Session } | { ok: false; response: Response };

/** Authenticates a request by session cookie and optionally requires a role and same-origin. */
export async function requireSession(
  req: Request,
  opts: { role?: Role; mutation?: boolean } = {},
): Promise<Guard> {
  if (opts.mutation && !isSameOrigin(req.headers)) {
    return { ok: false, response: apiError(403, "forbidden", "cross-origin request rejected") };
  }
  const session = await getSession(sessionTokenFrom(req.headers));
  if (!session) return { ok: false, response: apiError(401, "unauthorized") };
  if (opts.role === "admin" && session.role !== "admin") {
    return { ok: false, response: apiError(403, "forbidden", "admin role required") };
  }
  return { ok: true, session };
}

/** Accepts a session cookie or an API key (Bearer / x-api-key) carrying the `read` scope. */
export async function requireReadAccess(
  req: Request,
): Promise<{ ok: true; tenantId: string } | { ok: false; response: Response }> {
  const auth = req.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const key = bearer ?? req.headers.get("x-api-key");
  if (key) {
    const { resolveApiKey } = await import("@/lib/data/api-keys");
    const resolved = await resolveApiKey(key);
    if (!resolved) return { ok: false, response: apiError(401, "invalid_api_key") };
    if (!resolved.scopes.includes("read")) {
      return { ok: false, response: apiError(403, "insufficient_scope", "this API key cannot read metrics") };
    }
    return { ok: true, tenantId: resolved.tenantId };
  }
  const session = await requireSession(req);
  if (!session.ok) return session;
  return { ok: true, tenantId: session.session.tenantId };
}

/** A parsed JSON body as a field map; `null`, arrays and primitives become `{}` so field validation rejects them. */
export function jsonObject(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export async function readJson(req: Request, maxBytes: number): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > maxBytes) return { ok: false, response: apiError(413, "payload_too_large") };
  const text = await readTextCapped(req, maxBytes);
  if (text === null) return { ok: false, response: apiError(413, "payload_too_large") };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: apiError(400, "invalid_json") };
  }
}

/** Reads the body as UTF-8, aborting as soon as it exceeds `maxBytes` (also for chunked bodies). */
async function readTextCapped(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  // TextDecoder strips a leading BOM, matching Request.text().
  return new TextDecoder().decode(Buffer.concat(chunks));
}
