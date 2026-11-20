import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth/current";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await currentSession()) redirect("/dashboard");
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h1 className="text-xl font-semibold">Sign in to NeuraDash</h1>
        <p className="mb-6 mt-1 text-sm text-slate-400">Demo accounts are listed in the README.</p>
        <LoginForm />
      </div>
    </main>
  );
}
