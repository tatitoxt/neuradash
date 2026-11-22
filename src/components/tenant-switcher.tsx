"use client";

import { useEffect, useState } from "react";

type Tenant = { slug: string; name: string; role: string };

/** Dropdown for users with several memberships; hidden for single-tenant users. */
export function TenantSwitcher({ currentSlug }: { currentSlug: string }) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setTenants(d?.tenants ?? []))
      .catch(() => setTenants([]));
  }, []);

  if (tenants.length < 2) return null;

  async function switchTo(slug: string) {
    if (slug === currentSlug || busy) return;
    setBusy(true);
    const res = await fetch("/api/auth/switch-tenant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: slug }),
    });
    if (res.ok) {
      window.location.reload();
    } else {
      setBusy(false);
    }
  }

  return (
    <select
      data-testid="tenant-switcher"
      aria-label="Switch tenant"
      disabled={busy}
      value={currentSlug}
      onChange={(e) => switchTo(e.target.value)}
      className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-300"
    >
      {tenants.map((t) => (
        <option key={t.slug} value={t.slug}>
          {t.name}
        </option>
      ))}
    </select>
  );
}
