import { AppHeader } from "@/components/app-header";
import { requirePageSession } from "@/lib/auth/current";
import { listApiKeys } from "@/lib/data/api-keys";
import { listMembers } from "@/lib/data/members";
import { ApiKeysPanel } from "./api-keys-panel";
import { MembersPanel } from "./members-panel";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const session = await requirePageSession();
  if (session.role !== "admin") {
    return (
      <>
        <AppHeader session={session} />
        <main className="mx-auto max-w-3xl p-6">
          <h1 className="text-xl font-semibold">403 — Admins only</h1>
          <p className="mt-2 text-slate-400">Your role in {session.tenantName} is viewer.</p>
        </main>
      </>
    );
  }
  const [keys, members] = await Promise.all([listApiKeys(session.tenantId), listMembers(session.tenantId)]);
  return (
    <>
      <AppHeader session={session} />
      <main className="mx-auto max-w-5xl space-y-6 p-6">
        <h1 className="text-xl font-semibold">Admin · {session.tenantName}</h1>
        <ApiKeysPanel initialKeys={keys} />
        <MembersPanel initialMembers={members} selfId={session.userId} />
      </main>
    </>
  );
}
