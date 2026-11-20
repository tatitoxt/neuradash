import type { EventDTO } from "@/lib/live/types";

const time = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const typeColor: Record<string, string> = {
  error: "bg-red-500/15 text-red-300",
  purchase: "bg-violet-500/15 text-violet-300",
  signup: "bg-emerald-500/15 text-emerald-300",
};

export function LiveFeed({ events }: { events: EventDTO[] }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <h2 className="mb-3 text-sm font-medium text-slate-300">Live events</h2>
      {events.length === 0 ? (
        <p className="text-sm text-slate-500">No events yet.</p>
      ) : (
        <ul className="max-h-96 divide-y divide-slate-800 overflow-y-auto text-sm" data-testid="live-feed">
          {events.map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-2" data-testid="feed-item" data-event-id={e.id}>
              <span className="w-20 shrink-0 font-mono text-xs text-slate-500">{time.format(new Date(e.occurredAt))}</span>
              <span className={`rounded px-2 py-0.5 font-mono text-xs ${typeColor[e.type] ?? "bg-sky-500/15 text-sky-300"}`}>
                {e.type}
              </span>
              <span className="text-slate-400">{e.source}</span>
              {e.value !== null ? <span className="ml-auto font-mono tabular-nums text-slate-300">{e.value}</span> : null}
              <span className="sr-only">{JSON.stringify(e.properties)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
