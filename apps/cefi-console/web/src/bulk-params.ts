import type { QuoterParamSpec } from "../../shared/api.ts";

// The arithmetic behind the all-books parameter editor: set every book to a value, add to each
// book's own value, or scale it. Kept apart from the component so it can be tested.

export type BulkOp = "set" | "add" | "scale";

// The new value for one book, as the string the form holds, or an error. Integers round to whole
// numbers; everything else keeps up to 8 decimals, so 0.1 + 0.2 doesn't leak float noise.
export function applyOp(spec: QuoterParamSpec, op: BulkOp, current: string, raw: string): { value: string } | { error: string } {
  const v = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(v)) return { error: "enter a number" };
  const x = Number(v);
  if (op === "scale" && !(x > 0)) return { error: "scale by more than 0" };
  const cur = Number(current);
  if (op !== "set" && !Number.isFinite(cur)) return { error: "no current value" };
  const n = op === "set" ? x : op === "add" ? cur + x : cur * x;
  return { value: formatParam(spec, n) };
}

export function formatParam(spec: QuoterParamSpec, n: number): string {
  if (spec.type === "integer") return String(Math.round(n));
  return String(Number(n.toFixed(8)));
}

// Set and add only make sense when every book reads the value in the same unit. A size is in the
// base asset or the quote currency per book (its sizeUnit), and the base differs per book; scaling
// works whatever the unit.
export function opAllowed(op: BulkOp, units: string[]): boolean {
  return op === "scale" || new Set(units).size <= 1;
}
