import { allocationColors, type AllocationChange } from "../../positions.ts";
import { ShareBar } from "../ui.tsx";

// Before and after, for the two assets a trade touches.
export function AllocationShift({ change }: { change: AllocationChange[] }) {
  return (
    <span className="flex flex-col items-end gap-0.5">
      {change.map((c) => (
        <span key={c.symbol}>
          {c.symbol} <span className="text-muted">{c.before}%</span> <span aria-label="to">→</span> <span className="font-medium">{c.after}%</span>
        </span>
      ))}
    </span>
  );
}

// Now and after bars for the two assets a trade touches; whatever else the client holds fills the rest.
export function AllocationBars({ change }: { change: AllocationChange[] }) {
  const colors = allocationColors(change.map((c) => c.symbol));
  const bar = (key: "before" | "after") => (
    <ShareBar segments={change.map((c) => ({ key: c.symbol, pct: c[key], color: colors[c.symbol]! }))} />
  );
  return (
    <div className="flex flex-col gap-3">
      {(
        [
          ["Now", "before"],
          ["After", "after"],
        ] as const
      ).map(([label, key]) => (
        <div key={label} className="grid grid-cols-[44px_1fr] items-center gap-3">
          <span className="text-sm text-muted">{label}</span>
          {bar(key)}
        </div>
      ))}
      <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 p-0 text-sm text-label">
        {change.map((c) => (
          <li key={c.symbol} className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 rounded-full" style={{ background: colors[c.symbol] }} />
            {c.symbol} {c.before}% <span aria-label="to">→</span> <span className="font-medium text-ink">{c.after}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
