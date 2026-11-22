import { AppHeader } from "@/components/app-header";
import { MfaForm } from "@/components/mfa-form";
import { PasswordForm } from "@/components/password-form";
import { requirePageSession } from "@/lib/auth/current";

export const dynamic = "force-dynamic";

export default function AccountPage() {
  return <Account />;
}

async function Account() {
  const session = await requirePageSession();
  return (
    <>
      <AppHeader session={session} />
      <main className="mx-auto max-w-md p-6">
        <h1 className="text-xl font-semibold">Account</h1>
        <p className="mt-1 text-sm text-slate-400">{session.email}</p>
        <PasswordForm />
        <MfaForm />
      </main>
    </>
  );
}
