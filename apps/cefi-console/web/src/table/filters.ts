// Column filters, one model for every table. A column says what kind of filter it takes; the value
// lives in TanStack Table's columnFilters state. Tables backed by TanStack DB turn the active filters
// into a live query's where clause (dbWhere); the others let TanStack Table apply them (filterFnFor).
//
//   range  numbers: a lower bound (> or ≥), an upper bound (< or ≤), or both for a band
//   multi  a few distinct strings (symbol, status, ...): any of the chosen values
//   text   many distinct strings (order id, ...): contains, case-insensitive (% and _ are wildcards)
//   since  times: within the last N minutes

import { and, gt, gte, ilike, inArray, lt, lte } from "@tanstack/react-db";
import type { FilterFn } from "@tanstack/react-table";

export type FilterKind = "range" | "multi" | "text" | "since";

export interface RangeValue {
  min?: number;
  // Defaults to ">" and "<".
  minOp?: ">" | ">=";
  max?: number;
  maxOp?: "<" | "<=";
}
export interface SinceValue {
  minutes: number;
}
export type FilterValue = RangeValue | string[] | string | SinceValue;

export interface FilterMeta {
  kind: FilterKind;
  // The record field a DB live query filters on, when it differs from the column id.
  field?: string;
  // Shown values are the stored value × scale (100 for a 0–1 share shown as a percent).
  scale?: number;
  // How range bounds read in chips: "$", "%" or nothing.
  unit?: "$" | "%";
}

export function isActive(kind: FilterKind, v: FilterValue | undefined): boolean {
  if (v === undefined) return false;
  if (kind === "range") return (v as RangeValue).min !== undefined || (v as RangeValue).max !== undefined;
  if (kind === "multi") return (v as string[]).length > 0;
  if (kind === "text") return (v as string).trim().length > 0;
  return (v as SinceValue).minutes > 0;
}

// The chip text for an active filter, e.g. "Price > 200 and < 210".
export function describe(label: string, meta: FilterMeta, v: FilterValue): string {
  const fmt = (n: number) => (meta.unit === "$" ? `$${n.toLocaleString()}` : meta.unit === "%" ? `${n}%` : n.toLocaleString());
  switch (meta.kind) {
    case "range": {
      const r = v as RangeValue;
      const parts = [
        r.min !== undefined ? `${r.minOp === ">=" ? "≥" : ">"} ${fmt(r.min)}` : "",
        r.max !== undefined ? `${r.maxOp === "<=" ? "≤" : "<"} ${fmt(r.max)}` : "",
      ].filter(Boolean);
      return `${label} ${parts.join(" and ")}`;
    }
    case "multi": {
      const vals = v as string[];
      return `${label}: ${vals.length <= 3 ? vals.join(", ") : `${vals.slice(0, 2).join(", ")} +${vals.length - 2}`}`;
    }
    case "text":
      return `${label} contains "${(v as string).trim()}"`;
    case "since": {
      const m = (v as SinceValue).minutes;
      return `${label} within ${m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`}`;
    }
  }
}

// ---------- in TanStack Table ----------

export function filterFnFor<T>(meta: FilterMeta): FilterFn<T> {
  return (row, columnId, v: FilterValue) => {
    if (!isActive(meta.kind, v)) return true;
    const value = row.getValue(columnId);
    switch (meta.kind) {
      case "range":
        return inRange(value as number | null | undefined, v as RangeValue, meta.scale);
      case "multi":
        return (v as string[]).includes(String(value ?? ""));
      case "text":
        return String(value ?? "").toLowerCase().includes((v as string).trim().toLowerCase());
      case "since":
        return Number(value) >= Date.now() - (v as SinceValue).minutes * 60_000;
    }
  };
}

function inRange(value: number | null | undefined, r: RangeValue, scale = 1): boolean {
  if (value === null || value === undefined || Number.isNaN(value)) return false;
  const x = value * scale;
  if (r.min !== undefined && !(r.minOp === ">=" ? x >= r.min : x > r.min)) return false;
  if (r.max !== undefined && !(r.maxOp === "<=" ? x <= r.max : x < r.max)) return false;
  return true;
}

// ---------- in a TanStack DB live query ----------

export interface ActiveFilter {
  id: string;
  meta: FilterMeta;
  value: FilterValue;
}

// Filters are assembled at runtime from column metadata, so field references are untyped here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Expr = any;

// Builds the where clause for a row reference (the `o` in `.where(({ o }) => ...)`). Returns
// undefined when nothing is filtered. `now` is passed in so a "since" filter has a stable cutoff.
export function dbWhere(ref: Record<string, Expr>, filters: ActiveFilter[], now: number, extra: (Expr | undefined)[] = []): Expr | undefined {
  const parts: Expr[] = [];
  for (const f of filters) {
    if (!isActive(f.meta.kind, f.value)) continue;
    const field = ref[f.meta.field ?? f.id];
    const scale = f.meta.scale ?? 1;
    switch (f.meta.kind) {
      case "range": {
        const r = f.value as RangeValue;
        if (r.min !== undefined) parts.push((r.minOp === ">=" ? gte : gt)(field, r.min / scale));
        if (r.max !== undefined) parts.push((r.maxOp === "<=" ? lte : lt)(field, r.max / scale));
        break;
      }
      case "multi":
        parts.push(inArray(field, f.value as string[]));
        break;
      case "text":
        // DB's LIKE has no escape character, so % and _ in a search act as wildcards.
        parts.push(ilike(field, `%${(f.value as string).trim()}%`));
        break;
      case "since":
        parts.push(gte(field, now - (f.value as SinceValue).minutes * 60_000));
        break;
    }
  }
  for (const e of extra) if (e) parts.push(e);
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : and(parts[0], parts[1], ...parts.slice(2));
}
