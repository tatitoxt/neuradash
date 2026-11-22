"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const body = challenge
      ? { challenge, code: String(form.get("code") ?? "") }
      : { email: form.get("email"), password: form.get("password") };
    try {
      const res = await fetch(challenge ? "/api/auth/mfa" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { mfaRequired?: boolean; challenge?: string };
        if (data.mfaRequired && data.challenge) {
          setChallenge(data.challenge);
          return;
        }
        router.replace("/dashboard");
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      setError(data.message ?? "Sign-in failed");
    } catch {
      setError("Network error, please try again");
    } finally {
      setPending(false);
    }
  }

  if (challenge) {
    return (
      <form onSubmit={onSubmit} className="space-y-4">
        <p className="text-sm text-slate-400">Enter the 6-digit code from your authenticator app.</p>
        <label className="block text-sm">
          <span className="text-slate-300">Authentication code</span>
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            required
            autoFocus
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 tracking-widest outline-none focus:border-sky-500"
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-sky-600 px-3 py-2 font-medium text-white hover:bg-sky-500 disabled:opacity-60"
        >
          {pending ? "Verifying…" : "Verify"}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block text-sm">
        <span className="text-slate-300">Email</span>
        <input
          name="email"
          type="email"
          required
          autoComplete="username"
          className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-sky-500"
        />
      </label>
      <label className="block text-sm">
        <span className="text-slate-300">Password</span>
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-sky-500"
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-sky-600 px-3 py-2 font-medium text-white hover:bg-sky-500 disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
