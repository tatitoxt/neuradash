"use client";

import { useState } from "react";
import type { ApiKeyDTO } from "@/lib/data/api-keys";

const date = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export function ApiKeysPanel({ initialKeys }: { initialKeys: ApiKeyDTO[] }) {
  const [keys, setKeys] = useState(initialKeys);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const data = new FormData(formEl);
    const name = String(data.get("name") ?? "");
    const ttlDays = Number(data.get("ttl") ?? "0");
    const expiresAt = ttlDays > 0 ? new Date(Date.now() + ttlDays * 86_400_000).toISOString() : undefined;
    const limitRaw = String(data.get("rateLimit") ?? "").trim();
    const rateLimitPerMinute = limitRaw === "" ? null : Number(limitRaw);
    setError(null);
    const res = await fetch("/api/admin/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, expiresAt, rateLimitPerMinute }),
    });
    if (!res.ok) return setError("Could not create key");
    const body = (await res.json()) as { key: string; apiKey: ApiKeyDTO };
    setCreated(body.key);
    setKeys((k) => [body.apiKey, ...k]);
    formEl.reset();
  }

  async function revoke(id: string) {
    const res = await fetch(`/api/admin/api-keys/${id}`, { method: "DELETE" });
    if (!res.ok) return setError("Could not revoke key");
    setKeys((k) => k.map((key) => (key.id === id ? { ...key, revokedAt: new Date().toISOString() } : key)));
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <h2 className="mb-3 text-sm font-medium text-slate-300">Ingest API keys</h2>
      <form onSubmit={create} className="mb-4 flex gap-2">
        <input
          name="name"
          required
          maxLength={64}
          placeholder="Key name, e.g. backend-prod"
          aria-label="Key name"
          className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
        />
        <select
          name="ttl"
          aria-label="Expiry"
          defaultValue="0"
          className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
        >
          <option value="0">No expiry</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">1 year</option>
        </select>
        <input
          name="rateLimit"
          type="number"
          min={1}
          max={1000000}
          placeholder="Limit/min"
          aria-label="Ingest limit per minute"
          className="w-28 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
        />
        <button type="submit" className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500">
          Create key
        </button>
      </form>
      {created ? (
        <p className="mb-4 rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-300">
          New key (shown once): <code data-testid="new-api-key" className="font-mono">{created}</code>
        </p>
      ) : null}
      {error ? <p role="alert" className="mb-4 text-sm text-red-400">{error}</p> : null}
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr>
            <th className="py-2">Name</th>
            <th>Prefix</th>
            <th>Scopes</th>
            <th>Limit/min</th>
            <th>Expires</th>
            <th>Last used</th>
            <th />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {keys.map((k) => (
            <tr key={k.id} data-testid="api-key-row">
              <td className="py-2">{k.name}</td>
              <td className="font-mono text-slate-400">{k.prefix}…</td>
              <td className="text-slate-400">{k.scopes.join(", ")}</td>
              <td className="text-slate-400">{k.rateLimitPerMinute ?? "—"}</td>
              <td className={k.expiresAt && new Date(k.expiresAt) < new Date() ? "text-red-400" : "text-slate-400"}>
                {k.expiresAt ? date.format(new Date(k.expiresAt)) : "never"}
              </td>
              <td className="text-slate-400">{k.lastUsedAt ? date.format(new Date(k.lastUsedAt)) : "never"}</td>
              <td className="text-right">
                {k.revokedAt ? (
                  <span className="text-xs text-slate-500">revoked</span>
                ) : (
                  <button type="button" onClick={() => revoke(k.id)} className="text-xs text-red-400 hover:underline">
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
