import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db/client";
import { memberships, users, type Role } from "@/lib/db/schema";

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
