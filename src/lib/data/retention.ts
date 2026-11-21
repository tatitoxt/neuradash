import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db/client";
import { tenants } from "@/lib/db/schema";

/** The tenant's retention window in days; null keeps events forever. */
export async function getRetentionDays(tenantId: string): Promise<number | null> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ retentionDays: tenants.retentionDays })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return rows[0]?.retentionDays ?? null;
  });
}

/** Sets the tenant's event retention (1-3650 days, or null). */
export async function setRetentionDays(tenantId: string, days: number | null): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.execute(sql`select set_tenant_retention(${days})`),
  );
}

/** Deletes the tenant's events older than its retention; returns the count. */
export async function pruneEvents(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const res = await tx.execute(sql`select prune_tenant_events() as deleted`);
    return Number(res.rows[0]?.deleted ?? 0);
  });
}
