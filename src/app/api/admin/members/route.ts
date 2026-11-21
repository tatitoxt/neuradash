import { apiError, json, readJson, requireSession } from "@/lib/http";
import { inviteMember, listMembers } from "@/lib/data/members";
import type { Role } from "@/lib/db/schema";

const ROLES: readonly Role[] = ["admin", "viewer"];

export async function GET(req: Request): Promise<Response> {
  const auth = await requireSession(req, { role: "admin" });
  if (!auth.ok) return auth.response;
  return json({ members: await listMembers(auth.session.tenantId) });
}

/** POST {email, name?, role} — invite: join an existing account or create one with a temporary password. */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireSession(req, { role: "admin", mutation: true });
  if (!auth.ok) return auth.response;

  const parsed = await readJson(req, 8 * 1024);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as { email?: unknown; name?: unknown; role?: unknown };
  if (
    typeof body.email !== "string" ||
    (body.name !== undefined && typeof body.name !== "string") ||
    typeof body.role !== "string" ||
    !ROLES.includes(body.role as Role)
  ) {
    return apiError(422, "invalid_body", "expected {email, name?, role: admin|viewer}");
  }

  const result = await inviteMember(auth.session.tenantId, {
    email: body.email,
    name: body.name as string | undefined,
    role: body.role as Role,
  });
  if (!result.ok) {
    return result.reason === "already_member"
      ? apiError(409, "already_member", "that user already belongs to this tenant")
      : apiError(422, "invalid_email", "not a valid email address");
  }
  return json(result, 201);
}
