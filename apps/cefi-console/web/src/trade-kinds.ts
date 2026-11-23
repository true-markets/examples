// The Kind filter on the quoter's trades: "maker" takes every ladder level, "maker L0", "maker L1"
// and so on one level each, and the take kinds themselves.

export interface KindRow {
  kind: string; // maker, profit take or takeout
  level: number;
}

export const levelKind = (level: number) => `maker L${level}`;

// The filter's choices, with how many trades each covers: maker, then its levels in order, then the
// take kinds.
export function kindFacets(rows: KindRow[]): { value: string; count: number }[] {
  const kinds = new Map<string, number>();
  const levels = new Map<number, number>();
  for (const r of rows) {
    kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
    if (r.kind === "maker") levels.set(r.level, (levels.get(r.level) ?? 0) + 1);
  }
  const out: { value: string; count: number }[] = [];
  if (kinds.has("maker")) out.push({ value: "maker", count: kinds.get("maker")! });
  for (const [level, count] of [...levels].sort((a, b) => a[0] - b[0])) out.push({ value: levelKind(level), count });
  for (const [value, count] of kinds) if (value !== "maker") out.push({ value, count });
  return out;
}

// Whether a trade passes the chosen kinds (none chosen: every trade).
export function matchesKind(r: KindRow, chosen: string[] | undefined): boolean {
  if (!chosen?.length) return true;
  return chosen.includes(r.kind) || (r.kind === "maker" && chosen.includes(levelKind(r.level)));
}
