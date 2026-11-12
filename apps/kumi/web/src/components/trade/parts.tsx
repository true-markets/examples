import type { ReactNode } from "react";
import { sanitizeDecimal } from "../../format.ts";
import { useNow } from "../../hooks.ts";

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-hairline py-3">
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 text-right">{children}</dd>
    </div>
  );
}

// Ticks once a second on its own, so the rest of the panel does not re-render with it.
export function UpdatedAgo({ updatedAt }: { updatedAt: number }) {
  const now = useNow(1_000);
  return <>Updated {Math.max(0, Math.floor((now - updatedAt) / 1000))}s ago</>;
}

export function AmountInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <input
      aria-label={label}
      type="text"
      inputMode="decimal"
      autoFocus
      value={value}
      onChange={(e) => onChange(sanitizeDecimal(e.target.value))}
      style={{ width: `${Math.max(2, value.length + 0.5)}ch` }}
      className="min-w-0 border-0 bg-transparent p-0 font-[inherit] tracking-[inherit] text-ink outline-offset-4"
    />
  );
}
