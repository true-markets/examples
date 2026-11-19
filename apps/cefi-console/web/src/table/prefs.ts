// Per-table layout saved in this browser: which columns show, their order, their widths, and the
// sort. localStorage suits it: it's per device, needs no server, and survives reloads. Filters are
// deliberately not saved, so a reload never silently hides orders.

import type { ColumnSizingState, SortingState, VisibilityState } from "@tanstack/react-table";

export interface TableLayout {
  visibility: VisibilityState;
  order: string[];
  sizing: ColumnSizingState;
  sorting: SortingState;
}

// Bump when a table's columns change shape enough that an old saved layout would be wrong.
const VERSION = 1;
const key = (tableId: string) => `cefi-console:table:${tableId}:v${VERSION}`;

export function loadLayout(tableId: string): Partial<TableLayout> | undefined {
  try {
    const raw = localStorage.getItem(key(tableId));
    return raw ? (JSON.parse(raw) as Partial<TableLayout>) : undefined;
  } catch {
    return undefined;
  }
}

export function saveLayout(tableId: string, layout: TableLayout): void {
  try {
    localStorage.setItem(key(tableId), JSON.stringify(layout));
  } catch {
    // storage blocked or full: the layout just isn't remembered
  }
}

export function clearLayout(tableId: string): void {
  try {
    localStorage.removeItem(key(tableId));
  } catch {
    // nothing to clear
  }
}

// A saved column order with any columns added since it was saved appended in their default place,
// and any that no longer exist dropped.
export function reconcileOrder(saved: string[] | undefined, defaults: string[]): string[] {
  if (!saved?.length) return defaults;
  const known = saved.filter((id) => defaults.includes(id));
  for (const id of defaults) {
    if (known.includes(id)) continue;
    const before = defaults.indexOf(id);
    const after = known.findIndex((k) => defaults.indexOf(k) > before);
    known.splice(after < 0 ? known.length : after, 0, id);
  }
  return known;
}
