import { consumeIngestToken, resolveApiKey } from "@/lib/data/api-keys";
import { insertEvents } from "@/lib/data/events";
import { apiError, json, readJson } from "@/lib/http";
import { parseIngestBody } from "@/lib/ingest/schema";

const MAX_BODY_BYTES = 256 * 1024;

function apiKeyFrom(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-api-key");
}

/** Accepts one event or `{ events: [...] }`. The tenant is always the API key's tenant. */
export async function POST(req: Request): Promise<Response> {
  const key = apiKeyFrom(req);
  if (!key) return apiError(401, "missing_api_key", "send Authorization: Bearer <api key>");
  const resolved = await resolveApiKey(key);
  if (!resolved) return apiError(401, "invalid_api_key");
  if (!resolved.scopes.includes("ingest")) {
    return apiError(403, "insufficient_scope", "this API key cannot ingest events");
  }
  if (!(await consumeIngestToken(resolved.keyId))) {
    return apiError(429, "rate_limited", "this API key is over its per-minute ingest limit");
  }

  const raw = await readJson(req, MAX_BODY_BYTES);
  if (!raw.ok) return raw.response;
  const parsed = parseIngestBody(raw.body);
  if (!parsed.ok) return apiError(422, "invalid_event", parsed.error);

  const stored = await insertEvents(resolved.tenantId, parsed.events);
  return json({ accepted: stored.length, ids: stored.map((e) => e.id) }, 202);
}
