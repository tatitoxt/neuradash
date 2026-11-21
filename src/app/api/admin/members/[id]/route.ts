import { apiError, json, readJson, requireSession } from "@/lib/http";
import { removeMember, updateMemberRole } from "@/lib/data/members";
import type { Role } from "@/lib/db/schema";

const ROLES: readonly Role[] = ["admin", "viewer"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

/** PATCH {role} — change a member's role. Admins cannot demote themselves. */
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireSession(req, { role: "admin", mutation: true });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return apiError(404, "not_found");
  if (id === auth.session.userId) {
    return apiError(422, "self_change", "admins cannot change their own role");
  }

  const parsed = await readJson(req, 4 * 1024);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as { role?: unknown };
  if (typeof body.role !== "string" || !ROLES.includes(body.role as Role)) {
    return apiError(422, "invalid_body", "expected {role: admin|viewer}");
  }

  if (!(await updateMemberRole(auth.session.tenantId, id, body.role as Role))) {
    return apiError(404, "not_found", "no such member in this tenant");
  }
  return json({ userId: id, role: body.role });
}

/** DELETE — remove a member and their sessions in this tenant. Admins cannot remove themselves. */
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireSession(req, { role: "admin", mutation: true });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return apiError(404, "not_found");
  if (id === auth.session.userId) {
    return apiError(422, "self_remove", "admins cannot remove themselves");
  }
  if (!(await removeMember(auth.session.tenantId, id))) {
    return apiError(404, "not_found", "no such member in this tenant");
  }
  return new Response(null, { status: 204 });
}
