import type { Summary } from "@/lib/live/types";

const fmt = new Intl.NumberFormat("en-US");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function KpiCards({ summary }: { summary: Summary }) {
  const errorRate = summary.events ? (summary.errors / summary.events) * 100 : 0;
  const cards = [
    { id: "events", label: "Events", value: fmt.format(summary.events) },
    { id: "error-rate", label: "Error rate", value: `${errorRate.toFixed(1)}%`, hint: `${fmt.format(summary.errors)} errors` },
    { id: "revenue", label: "Revenue", value: money.format(summary.revenue) },
    { id: "sources", label: "Active sources", value: fmt.format(summary.sources) },
  ];
  return (
    <section className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label="Key metrics">
      {cards.map((c) => (
        <div key={c.id} className="rounded-xl border border-slate-800 bg-slate-900 p-4" data-testid={`kpi-${c.id}`}>
          <p className="text-xs uppercase tracking-wide text-slate-400">{c.label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid={`kpi-${c.id}-value`}>
            {c.value}
          </p>
          {c.hint ? <p className="text-xs text-slate-500">{c.hint}</p> : null}
        </div>
      ))}
    </section>
  );
}
