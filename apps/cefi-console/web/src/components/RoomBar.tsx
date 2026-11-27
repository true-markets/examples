import { qty as fmtQty } from "../format.ts";
import { cx } from "./ui.tsx";

// Where a book's position sits under its max position change, as a bar with zero in the middle:
// green to the right while long, red to the left while short, out to the limit at each end. The
// last stretch each way is shaded, since that side's quotes thin out as the position nears it.

// The last fraction of the limit each way that's shaded.
const NEAR = 0.15;

export interface RoomBarProps {
  // The position over the max position change: −1 is the limit short, +1 the limit long.
  lean: number;
  // For the tooltip: the limit and the room left each way, in base.
  max?: number;
  buyRoom?: number;
  sellRoom?: number;
  base?: string;
  // Under the bar, how far it leans ("88% long"); otherwise beside it.
  label?: "beside" | "none";
  className?: string;
}

export function leanText(lean: number): string {
  const pct = Math.round(Math.min(Math.abs(lean), 1) * 100);
  return pct === 0 ? "flat" : `${pct}% ${lean > 0 ? "long" : "short"}`;
}

export function RoomBar({ lean, max, buyRoom, sellRoom, base, label = "beside", className }: RoomBarProps) {
  const l = Math.max(-1, Math.min(1, lean));
  const near = Math.abs(l) >= 1 - NEAR;
  const title =
    max === undefined
      ? leanText(lean)
      : `${leanText(lean)} of the max position change (${fmtQty(max, 6)} ${base ?? ""} each way). ` +
        `Room left: buy ${fmtQty(buyRoom ?? 0, 6)}, sell ${fmtQty(sellRoom ?? 0, 6)}${base ? ` ${base}` : ""}.`;
  return (
    <span className={cx("inline-flex w-full items-center gap-2", className)} title={title}>
      <span
        className="relative h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-raised"
        role="meter"
        aria-label="Position against the max position change"
        aria-valuemin={-100}
        aria-valuemax={100}
        aria-valuenow={Math.round(l * 100)}
        aria-valuetext={leanText(lean)}
      >
        <span className="absolute inset-y-0 left-0 bg-accent-soft" style={{ width: `${NEAR * 50}%` }} />
        <span className="absolute inset-y-0 right-0 bg-accent-soft" style={{ width: `${NEAR * 50}%` }} />
        <span className={cx("absolute inset-y-0", l >= 0 ? "left-1/2 bg-buy" : "right-1/2 bg-sell")} style={{ width: `${Math.abs(l) * 50}%` }} />
        <span className="absolute -inset-y-px left-1/2 w-px bg-faint" />
      </span>
      {label === "beside" && (
        <span className={cx("num w-16 shrink-0 text-right text-[11px]", near ? "text-accent" : l === 0 ? "text-faint" : "text-muted")}>{leanText(lean)}</span>
      )}
    </span>
  );
}
