import Link from "next/link";
import { RANGES, type RangeKey } from "@/lib/range";

export function RangeFilter({ current }: { current: RangeKey }) {
  return (
    <nav aria-label="Time range" className="flex gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1">
      {(Object.keys(RANGES) as RangeKey[]).map((key) => (
        <Link
          key={key}
          href={`/dashboard?range=${key}`}
          aria-current={key === current ? "page" : undefined}
          className={`rounded-md px-3 py-1 text-sm ${key === current ? "bg-sky-600 text-white" : "text-slate-400 hover:text-slate-100"}`}
        >
          {key}
        </Link>
      ))}
    </nav>
  );
}
