import { and, eq } from "drizzle-orm";
import { withTenant, withUser } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { generateSessionToken } from "@/lib/auth/tokens";
import { memberships, sessions, tenants, users, type Role } from "@/lib/db/schema";

export type MemberDTO = { userId: string; email: string; name: string; role: Role };

export async function listMembers(tenantId: string): Promise<MemberDTO[]> {
  return withTenant(tenantId, (tx) =>
    tx
      .select({ userId: users.id, email: users.email, name: users.name, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.tenantId, tenantId))
      .orderBy(users.email),
  );
}

export type TenantMembership = { slug: string; name: string; role: Role };

/** Every tenant a user belongs to — used for the tenant switcher and `/api/me`. */
export async function listMemberships(userId: string): Promise<TenantMembership[]> {
  return withUser(userId, (tx) =>
    tx
      .select({ slug: tenants.slug, name: tenants.name, role: memberships.role })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(eq(memberships.userId, userId))
      .orderBy(tenants.slug),
  );
}

export type InviteResult =
  | { ok: true; member: MemberDTO; temporaryPassword: string | null }
  | { ok: false; reason: "already_member" | "invalid" };

/**
 * Adds email to the tenant. An existing user account joins directly; a new one is
 * created with a random temporary password that is returned once (invite flow has
 * no mailer — the admin hands it over). Role is validated by the enum.
 */
export async function inviteMember(
  tenantId: string,
  input: { email: string; name?: string; role: Role },
): Promise<InviteResult> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, reason: "invalid" };
  const name = (input.name ?? "").trim() || email.split("@")[0]!;

  // memberships is tenant-scoped under RLS: run inside the tenant context.
  return withTenant(tenantId, async (tx) => {
    let [existing] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
    let temporaryPassword: string | null = null;
    if (!existing) {
      temporaryPassword = generateSessionToken().slice(0, 16);
      const passwordHash = await hashPassword(temporaryPassword);
      // Another tenant may create the same account concurrently; then join that account instead.
      const [created] = await tx
        .insert(users)
        .values({ email, name, passwordHash })
        .onConflictDoNothing({ target: users.email })
        .returning();
      if (created) {
        await tx.insert(memberships).values({ tenantId, userId: created.id, role: input.role });
        return { ok: true as const, member: { userId: created.id, email, name, role: input.role }, temporaryPassword };
      }
      temporaryPassword = null;
      [existing] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
      if (!existing) throw new Error("user vanished after email conflict");
    }
    {
      const [already] = await tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, existing.id)))
        .limit(1);
      if (already) return { ok: false as const, reason: "already_member" as const };
      await tx.insert(memberships).values({ tenantId, userId: existing.id, role: input.role });
      return { ok: true as const, member: { userId: existing.id, email, name: existing.name, role: input.role }, temporaryPassword };
    }
  });
}

export async function updateMemberRole(tenantId: string, userId: string, role: Role): Promise<boolean> {
  const rows = await withTenant(tenantId, (tx) => tx
    .update(memberships)
    .set({ role })
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
    .returning({ userId: memberships.userId }));
  return rows.length > 0;
}

/** Removes the membership and kills that user's sessions scoped to this tenant. */
export async function removeMember(tenantId: string, userId: string): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .delete(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
      .returning({ userId: memberships.userId });
    if (rows.length === 0) return false;
    await tx.delete(sessions).where(and(eq(sessions.userId, userId), eq(sessions.tenantId, tenantId)));
    return true;
  });
}
