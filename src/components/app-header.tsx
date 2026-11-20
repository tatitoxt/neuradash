import Link from "next/link";
import { LogoutButton } from "@/components/logout-button";
import type { Session } from "@/lib/auth/session";

export function AppHeader({ session }: { session: Session }) {
  return (
    <header className="border-b border-slate-800 bg-slate-950/80">
      <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
        <Link href="/dashboard" className="font-semibold tracking-tight">
          NeuraDash
        </Link>
        <nav className="flex gap-4 text-sm text-slate-400">
          <Link href="/dashboard" className="hover:text-slate-100">
            Dashboard
          </Link>
          {session.role === "admin" ? (
            <Link href="/admin" className="hover:text-slate-100">
              Admin
            </Link>
          ) : null}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span data-testid="tenant-name" className="text-slate-300">
            {session.tenantName}
          </span>
          <span data-testid="user-role" className="rounded bg-slate-800 px-2 py-0.5 text-xs uppercase text-slate-400">
            {session.role}
          </span>
          <span className="hidden text-slate-500 sm:inline">{session.email}</span>
          <LogoutButton />
        </div>
      </div>
    </header>
  );
}
