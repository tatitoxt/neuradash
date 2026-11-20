"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { SeriesPoint } from "@/lib/live/types";

function tickFormatter(bucketMs: number) {
  const opts: Intl.DateTimeFormatOptions =
    bucketMs >= 6 * 3_600_000 ? { month: "short", day: "numeric", hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" };
  const f = new Intl.DateTimeFormat("en-US", opts);
  return (t: number) => f.format(new Date(t));
}

const tooltipStyle = { backgroundColor: "#0f172a", border: "1px solid #334155", borderRadius: 8 };

export function Charts({ series, bucketMs }: { series: SeriesPoint[]; bucketMs: number }) {
  const fmt = tickFormatter(bucketMs);
  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4" data-testid="chart-volume">
        <h2 className="mb-2 text-sm font-medium text-slate-300">Event volume</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series}>
              <CartesianGrid stroke="#1e293b" vertical={false} />
              <XAxis dataKey="t" tickFormatter={fmt} stroke="#64748b" fontSize={12} minTickGap={24} />
              <YAxis stroke="#64748b" fontSize={12} allowDecimals={false} width={40} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={(t) => fmt(Number(t))} />
              <Legend />
              <Area type="monotone" dataKey="events" name="Events" stroke="#38bdf8" fill="#38bdf833" isAnimationActive={false} />
              <Area type="monotone" dataKey="errors" name="Errors" stroke="#f87171" fill="#f8717133" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4" data-testid="chart-revenue">
        <h2 className="mb-2 text-sm font-medium text-slate-300">Revenue (USD)</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series}>
              <CartesianGrid stroke="#1e293b" vertical={false} />
              <XAxis dataKey="t" tickFormatter={fmt} stroke="#64748b" fontSize={12} minTickGap={24} />
              <YAxis stroke="#64748b" fontSize={12} width={48} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={(t) => fmt(Number(t))} />
              <Bar dataKey="revenue" name="Revenue" fill="#a78bfa" isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
}
