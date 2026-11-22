"use client";

import { useEffect, useState } from "react";

type Enrollment = { secret: string; uri: string };

export function MfaForm() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [codesRemaining, setCodesRemaining] = useState(0);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);

  useEffect(() => {
    fetch("/api/me/mfa")
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { enabled?: boolean; codesRemaining?: number } | null) => {
        setEnabled(b?.enabled === true);
        setCodesRemaining(b?.codesRemaining ?? 0);
      })
      .catch(() => setEnabled(false));
  }, []);

  async function begin() {
    setBusy(true);
    setStatus(null);
    const res = await fetch("/api/me/mfa", { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      setStatus({ kind: "err", text: "Could not start enrollment" });
      return;
    }
    setEnrollment(await res.json());
  }

  async function confirm() {
    setBusy(true);
    setStatus(null);
    const res = await fetch("/api/me/mfa/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setStatus({ kind: "err", text: body.message ?? "Invalid code" });
      return;
    }
    const body = (await res.json()) as { recoveryCodes?: string[] };
    setEnrollment(null);
    setCode("");
    setEnabled(true);
    setFreshCodes(body.recoveryCodes ?? null);
    setCodesRemaining(body.recoveryCodes?.length ?? 0);
    setStatus({ kind: "ok", text: "Two-factor authentication is on." });
  }

  async function regenerate() {
    setBusy(true);
    setStatus(null);
    const res = await fetch("/api/me/mfa/codes", { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      setStatus({ kind: "err", text: "Could not generate new codes" });
      return;
    }
    const body = (await res.json()) as { recoveryCodes?: string[] };
    setFreshCodes(body.recoveryCodes ?? null);
    setCodesRemaining(body.recoveryCodes?.length ?? 0);
    setStatus({ kind: "ok", text: "New recovery codes generated — the old ones no longer work." });
  }

  async function disable() {
    setBusy(true);
    setStatus(null);
    const res = await fetch("/api/me/mfa", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setStatus({ kind: "err", text: body.message ?? "Could not disable MFA" });
      return;
    }
    setPassword("");
    setEnabled(false);
    setStatus({ kind: "ok", text: "Two-factor authentication is off." });
  }

  return (
    <section className="mt-8 space-y-3">
      <h2 className="text-sm font-medium text-slate-300">Two-factor authentication</h2>
      {enabled === null ? <p className="text-sm text-slate-500">Loading…</p> : null}

      {enabled === false && !enrollment ? (
        <>
          <p className="text-sm text-slate-500">Sign-ins only need your password today.</p>
          <button
            type="button"
            onClick={begin}
            disabled={busy}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
          >
            Enable MFA
          </button>
        </>
      ) : null}

      {enrollment ? (
        <div className="space-y-3 rounded-md border border-slate-700 bg-slate-900 p-3">
          <p className="text-sm text-slate-400">
            Add this secret to your authenticator app, then enter the 6-digit code it shows.
          </p>
          <code className="block break-all rounded bg-slate-950 px-2 py-1 text-xs text-sky-300">
            {enrollment.secret}
          </code>
          <code className="block break-all rounded bg-slate-950 px-2 py-1 text-xs text-slate-500">
            {enrollment.uri}
          </code>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={confirm}
            disabled={busy || code.length < 6}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
          >
            Confirm code
          </button>
        </div>
      ) : null}

      {freshCodes ? (
        <div className="space-y-2 rounded-md border border-amber-800 bg-amber-950/40 p-3">
          <p className="text-sm font-medium text-amber-300">
            Recovery codes — save them now, they are shown only once.
          </p>
          <p className="text-xs text-slate-400">
            Each code signs you in once if you lose your authenticator.
          </p>
          <div className="grid grid-cols-2 gap-1">
            {freshCodes.map((c) => (
              <code key={c} className="rounded bg-slate-950 px-2 py-1 text-center text-xs text-sky-300">
                {c}
              </code>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setFreshCodes(null)}
            className="text-xs text-slate-400 underline hover:text-slate-300"
          >
            I saved them — hide
          </button>
        </div>
      ) : null}

      {enabled === true ? (
        <div className="space-y-3">
          <p className="text-sm text-emerald-400">MFA is on — sign-ins require your authenticator code.</p>
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-400">
              Recovery codes left: <span className="text-slate-200">{codesRemaining}</span>
            </span>
            <button
              type="button"
              onClick={regenerate}
              disabled={busy}
              className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              Regenerate
            </button>
          </div>
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Password to disable MFA"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={disable}
            disabled={busy || !password}
            className="rounded-md border border-red-800 px-4 py-2 text-sm text-red-300 hover:bg-red-950 disabled:opacity-50"
          >
            Disable MFA
          </button>
        </div>
      ) : null}

      {status ? (
        <p role="status" className={`text-sm ${status.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>
          {status.text}
        </p>
      ) : null}
    </section>
  );
}
