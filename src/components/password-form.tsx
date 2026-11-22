"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function PasswordForm() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    const res = await fetch("/api/me/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setStatus({ kind: "err", text: body.message ?? "Password change failed" });
      return;
    }
    setStatus({ kind: "ok", text: "Password updated — other sessions were signed out." });
    setCurrent("");
    setNext("");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="mt-8 space-y-4">
      <h2 className="text-sm font-medium text-slate-300">Change password</h2>
      <input
        type="password"
        required
        autoComplete="current-password"
        placeholder="Current password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
      />
      <input
        type="password"
        required
        minLength={10}
        autoComplete="new-password"
        placeholder="New password (min 10 characters)"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Update password"}
      </button>
      {status ? (
        <p role="status" className={`text-sm ${status.kind === "ok" ? "text-emerald-400" : "text-rose-400"}`}>
          {status.text}
        </p>
      ) : null}
    </form>
  );
}
