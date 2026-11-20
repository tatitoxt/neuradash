import { AppHeader } from "@/components/app-header";
import { Dashboard } from "@/components/dashboard";
import { requirePageSession } from "@/lib/auth/current";
import { listRecentEvents } from "@/lib/data/events";
import { getMetrics } from "@/lib/data/metrics";
import { parseRange } from "@/lib/range";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const session = await requirePageSession();
  const range = parseRange((await searchParams).range);
  const [metrics, feed] = await Promise.all([
    getMetrics(session.tenantId, range),
    listRecentEvents(session.tenantId, { limit: 50 }),
  ]);
  return (
    <>
      <AppHeader session={session} />
      <main className="mx-auto max-w-7xl p-6">
        <Dashboard key={range} initialMetrics={metrics} initialFeed={feed} />
      </main>
    </>
  );
}
