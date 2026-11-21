import { z } from "zod";
import { API_KEY_SCOPES, createApiKey, listApiKeys } from "@/lib/data/api-keys";
import { apiError, json, readJson, requireSession } from "@/lib/http";

const bodySchema = z.object({
  name: z.string().trim().min(1).max(64),
  scopes: z.array(z.enum(API_KEY_SCOPES)).optional(),
  expiresAt: z.iso.datetime().optional(),
});

export async function GET(req: Request): Promise<Response> {
  const auth = await requireSession(req, { role: "admin" });
  if (!auth.ok) return auth.response;
  return json({ apiKeys: await listApiKeys(auth.session.tenantId) });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireSession(req, { role: "admin", mutation: true });
  if (!auth.ok) return auth.response;
  const raw = await readJson(req, 1024);
  if (!raw.ok) return raw.response;
  const parsed = bodySchema.safeParse(raw.body);
  if (!parsed.success) {
    return apiError(400, "invalid_request", "name is required (1-64 chars); scopes/expiresAt optional");
  }
  const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return apiError(400, "invalid_request", "expiresAt must be in the future");
  }
  const created = await createApiKey(auth.session.tenantId, parsed.data.name, {
    scopes: parsed.data.scopes,
    expiresAt,
  });
  return json(created, 201);
}
