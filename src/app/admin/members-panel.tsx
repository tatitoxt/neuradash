"use client";

import { useState } from "react";
import type { MemberDTO } from "@/lib/data/members";

export function MembersPanel({ initialMembers, selfId }: { initialMembers: MemberDTO[]; selfId: string }) {
  const [members, setMembers] = useState(initialMembers);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const data = new FormData(formEl);
    setError(null);
    const res = await fetch("/api/admin/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: String(data.get("email") ?? ""),
        name: String(data.get("name") ?? "") || undefined,
        role: String(data.get("role") ?? "viewer"),
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return setError(
        body?.error === "already_member"
          ? "That user already belongs to this tenant"
          : body?.error === "email_in_use"
            ? "That email already has an account and cannot be invited into another tenant"
            : "Could not invite member",
      );
    }
    const body = (await res.json()) as { member: MemberDTO; temporaryPassword: string | null };
    setMembers((m) => [...m, body.member].sort((a, b) => a.email.localeCompare(b.email)));
    setTemporaryPassword(body.temporaryPassword);
    formEl.reset();
  }

  async function setRole(userId: string, role: string) {
    setError(null);
    const res = await fetch(`/api/admin/members/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) return setError("Could not change role");
    setMembers((m) => m.map((x) => (x.userId === userId ? { ...x, role: role as MemberDTO["role"] } : x)));
  }

  async function remove(userId: string) {
    setError(null);
    const res = await fetch(`/api/admin/members/${userId}`, { method: "DELETE" });
    if (!res.ok) return setError("Could not remove member");
    setMembers((m) => m.filter((x) => x.userId !== userId));
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <h2 className="mb-3 text-sm font-medium text-slate-300">Members</h2>
      <form onSubmit={invite} className="mb-4 flex gap-2">
        <input
          name="email"
          type="email"
          required
          aria-label="Member email"
          placeholder="teammate@company.com"
          className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
        />
        <input
          name="name"
          aria-label="Display name"
          placeholder="Display name (optional)"
          className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
        />
        <select name="role" aria-label="Role" defaultValue="viewer" className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm">
          <option value="viewer">viewer</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit" className="rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900">
          Invite
        </button>
      </form>
      {temporaryPassword ? (
        <p data-testid="temporary-password" className="mb-3 rounded-md border border-amber-700/50 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
          New account created — hand this temporary password to the member (shown once):{" "}
          <code className="font-mono">{temporaryPassword}</code>
        </p>
      ) : null}
      {error ? <p className="mb-3 text-xs text-red-400">{error}</p> : null}
      <ul className="divide-y divide-slate-800 text-sm">
        {members.map((m) => (
          <li key={m.userId} className="flex items-center justify-between gap-3 py-2">
            <span>
              {m.name} <span className="text-slate-500">{m.email}</span>
            </span>
            <span className="flex items-center gap-2">
              {m.userId === selfId ? (
                <span className="text-xs uppercase text-slate-400">{m.role} (you)</span>
              ) : (
                <>
                  <select
                    aria-label={`Role for ${m.email}`}
                    value={m.role}
                    onChange={(e) => setRole(m.userId, e.target.value)}
                    className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-xs uppercase text-slate-400"
                  >
                    <option value="viewer">viewer</option>
                    <option value="admin">admin</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => remove(m.userId)}
                    aria-label={`Remove ${m.email}`}
                    className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-400 hover:border-red-700 hover:text-red-400"
                  >
                    Remove
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
