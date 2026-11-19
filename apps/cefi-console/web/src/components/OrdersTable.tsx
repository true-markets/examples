import { eq, ilike, inArray, or, useLiveQuery } from "@tanstack/react-db";
import { createColumnHelper, type ColumnDef, type ColumnFiltersState, type RowSelectionState } from "@tanstack/react-table";
import { Ban, ChevronDown, Pencil, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { isActionable, isOpen } from "../../../shared/orders.ts";
import { useCancelMany, useCancelOrder, useOrderHistory } from "../api.ts";
import { ordersCollection, toOrderRecord, type OrderRecord } from "../db.ts";
import { price, qty, shortId, time } from "../format.ts";
import { store, useOrders } from "../store.ts";
import { DataTable, idOf, type ColMeta } from "../table/DataTable.tsx";
import { FilterEditor, type Facet } from "../table/FilterEditor.tsx";
import { dbWhere, isActive, type ActiveFilter, type FilterValue } from "../table/filters.ts";
import { Popover } from "../table/Popover.tsx";
import { useUi } from "../ui-state.tsx";
import { ConfirmCancel } from "./ConfirmCancel.tsx";
import { ModifyDialog } from "./ModifyDialog.tsx";
import { Button, Panel, Segmented, SideText, StatusBadge, cx } from "./ui.tsx";

type View = "open" | "filled" | "canceled" | "all";

const col = createColumnHelper<OrderRecord>();
const m = (meta: ColMeta) => meta;

// Whole percents, with one decimal under 10% so a small partial fill doesn't read as 0%.
function fillPct(p: number): string {
  if (p <= 0) return "0%";
  if (p >= 1) return "100%";
  const v = p * 100;
  return v < 10 ? `${Math.max(0.1, Math.floor(v * 10) / 10)}%` : `${Math.floor(v)}%`;
}

// Columns whose filter is a multi-select, and the record field their choices come from.
const MULTI: Record<string, keyof OrderRecord> = { symbol: "symbol", side: "side", type: "type", tif: "tif", status: "statusLabel", event: "event" };

// Your orders, from a TanStack DB live query over the orders collection: the column filters, the
// Open/Filled/Canceled tab and the search box all become its where clause, so as DROPCOPY updates
// stream in, only the orders that changed are re-evaluated. Sorting, paging, column layout and
// selection are TanStack Table's.
export function OrdersTable() {
  useOrderHistory();
  const all = useOrders();
  const { symbol: selectedSymbol, setSymbol, setFocusOrderId, focusOrderId } = useUi();
  const { mutate: cancelOrder } = useCancelOrder();
  const cancelMany = useCancelMany();

  const [view, setView] = useState<View>("open");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<ColumnFiltersState>([]);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [modifying, setModifying] = useState<OrderRecord>();
  const [confirm, setConfirm] = useState<string[]>();
  const [symbolMenu, setSymbolMenu] = useState<HTMLElement>();

  const columns = useMemo<ColumnDef<OrderRecord, unknown>[]>(
    () =>
      [
        col.display({
          id: "select",
          meta: m({ label: "Select", fixed: "left" }),
          size: 32,
          enableSorting: false,
          enableResizing: false,
          header: ({ table }) => (
            <input
              type="checkbox"
              aria-label="Select all actionable"
              checked={table.getIsAllPageRowsSelected()}
              ref={(el) => {
                if (el) el.indeterminate = table.getIsSomePageRowsSelected();
              }}
              onChange={table.getToggleAllPageRowsSelectedHandler()}
            />
          ),
          cell: ({ row }) => (
            <input
              type="checkbox"
              aria-label="Select order"
              checked={row.getIsSelected()}
              disabled={!row.getCanSelect()}
              onChange={row.getToggleSelectedHandler()}
              onClick={(e) => e.stopPropagation()}
            />
          ),
        }),
        col.accessor("updatedMs", {
          id: "updated",
          header: "Updated",
          size: 104,
          meta: m({ label: "Updated", filter: { kind: "since", field: "updatedMs" } }),
          cell: (c) => <span className="num text-muted">{time(c.row.original.updatedNs)}</span>,
        }),
        col.accessor("symbol", { header: "Symbol", size: 116, meta: m({ label: "Symbol", filter: { kind: "multi" } }), cell: (c) => <span className="font-medium">{c.getValue()}</span> }),
        col.accessor("side", { header: "Side", size: 68, meta: m({ label: "Side", filter: { kind: "multi" } }), cell: (c) => <SideText side={c.getValue()} /> }),
        col.accessor("type", { header: "Type", size: 66, meta: m({ label: "Type", filter: { kind: "multi" } }), cell: (c) => <span className="text-muted">{c.getValue()}</span> }),
        col.accessor("tif", { header: "TIF", size: 60, meta: m({ label: "TIF", filter: { kind: "multi" } }), cell: (c) => <span className="text-muted">{c.getValue()}</span> }),
        col.accessor("priceN", {
          id: "price",
          header: "Price",
          size: 88,
          sortUndefined: "last",
          meta: m({ label: "Price", align: "right", filter: { kind: "range", field: "priceN", unit: "$" } }),
          cell: (c) => <span className="num">{price(c.row.original.price)}</span>,
        }),
        col.accessor("qtyN", {
          id: "qty",
          header: "Qty",
          size: 76,
          meta: m({ label: "Qty", align: "right", filter: { kind: "range", field: "qtyN" } }),
          cell: (c) => <span className="num">{qty(c.row.original.qty)}</span>,
        }),
        col.accessor("notionalN", {
          id: "notional",
          header: "Notional",
          size: 92,
          sortUndefined: "last",
          meta: m({ label: "Notional", align: "right", hidden: true, filter: { kind: "range", field: "notionalN", unit: "$" } }),
          cell: (c) => <span className="num text-muted">{c.getValue() === null ? "—" : `$${(c.getValue() as number).toFixed(2)}`}</span>,
        }),
        col.accessor("filledPct", {
          id: "filled",
          header: "Filled",
          size: 150,
          meta: m({ label: "Filled", align: "right", filter: { kind: "range", field: "filledPct", scale: 100, unit: "%" } }),
          cell: (c) => {
            const o = c.row.original;
            const pct = o.filledPct;
            return (
              <div className="flex items-center justify-end gap-2">
                <span className="num text-muted">{qty(o.executedQty)}</span>
                <div className="h-1 w-10 shrink-0 overflow-hidden rounded bg-raised">
                  <div className={cx("h-full", pct >= 1 ? "bg-buy" : "bg-info")} style={{ width: `${Math.min(100, pct * 100)}%` }} />
                </div>
                <span className={cx("num w-9 text-right text-[11px]", pct >= 1 ? "text-buy" : pct > 0 ? "text-ink" : "text-faint")}>{fillPct(pct)}</span>
              </div>
            );
          },
        }),
        col.accessor("leavesN", {
          id: "leaves",
          header: "Leaves",
          size: 84,
          meta: m({ label: "Leaves", align: "right", filter: { kind: "range", field: "leavesN" } }),
          cell: (c) => <span className="num">{qty(c.row.original.leavesQty)}</span>,
        }),
        col.accessor("vwapN", {
          id: "vwap",
          header: "Avg px",
          size: 84,
          sortUndefined: "last",
          meta: m({ label: "Avg px", align: "right", filter: { kind: "range", field: "vwapN", unit: "$" } }),
          cell: (c) => <span className="num text-muted">{price(c.row.original.vwap)}</span>,
        }),
        col.accessor("statusLabel", {
          id: "status",
          header: "Status",
          size: 104,
          meta: m({ label: "Status", filter: { kind: "multi" } }),
          cell: (c) => <StatusBadge status={c.row.original.status} partial={c.row.original.partial} />,
        }),
        col.accessor("event", {
          id: "event",
          header: "Event",
          size: 84,
          meta: m({ label: "Event", filter: { kind: "multi" } }),
          cell: (c) => (
            <span className="text-muted" title={c.row.original.text}>
              {c.getValue() || "—"}
              {c.row.original.text && <span className="ml-1 text-sell">•</span>}
            </span>
          ),
        }),
        col.accessor("orderId", {
          header: "Order ID",
          size: 96,
          meta: m({ label: "Order ID", filter: { kind: "text" } }),
          cell: (c) => (
            <span className="num text-faint" title={c.getValue()}>
              {shortId(c.getValue())}
            </span>
          ),
        }),
        col.accessor((o) => o.externalId ?? "", {
          id: "externalId",
          header: "Ext ID",
          size: 140,
          meta: m({ label: "Ext ID", filter: { kind: "text", field: "externalId" } }),
          cell: (c) => (
            <span className="num text-faint" title={c.row.original.externalId}>
              {c.row.original.externalId ?? "—"}
            </span>
          ),
        }),
        col.accessor("createdMs", {
          id: "created",
          header: "Created",
          size: 104,
          meta: m({ label: "Created", filter: { kind: "since", field: "createdMs" } }),
          cell: (c) => <span className="num text-faint">{time(c.row.original.createdNs)}</span>,
        }),
        col.display({
          id: "actions",
          meta: m({ label: "Actions", fixed: "right" }),
          size: 64,
          enableSorting: false,
          enableResizing: false,
          header: "",
          cell: ({ row }) => {
            const o = row.original;
            const can = isActionable(o.status);
            return (
              <div className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                <Button tone="ghost" size="xs" title="Modify price or quantity" disabled={!can || o.type !== "LIMIT"} onClick={() => setModifying(o)}>
                  <Pencil size={13} />
                </Button>
                <Button tone="ghost" size="xs" title="Cancel order" disabled={!can} onClick={() => cancelOrder(o.orderId)} className="hover:text-sell">
                  <X size={14} />
                </Button>
              </div>
            );
          },
        }),
      ] as ColumnDef<OrderRecord, unknown>[],
    // Stable: flexRender treats cell functions as components, so new ones would re-mount every cell.
    [cancelOrder],
  );

  // ---------- the live query ----------

  const metaById = useMemo(() => Object.fromEntries(columns.map((c) => [idOf(c), (c.meta as ColMeta).filter])), [columns]);
  const filtersKey = JSON.stringify(filters);
  const active = useMemo<ActiveFilter[]>(
    () => filters.flatMap((f) => (metaById[f.id] && isActive(metaById[f.id]!.kind, f.value as FilterValue) ? [{ id: f.id, meta: metaById[f.id]!, value: f.value as FilterValue }] : [])),
    // filtersKey stands for the filters' contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtersKey, metaById],
  );
  // "Within the last N minutes" filters need a clock; it ticks every 10 s, and only while one is set.
  const now = useClock(active.some((f) => f.meta.kind === "since") ? 10_000 : 0);
  const q = search.trim();

  const { data: rows = [] } = useLiveQuery({
    query: (qb) => {
      const base = qb.from({ o: ordersCollection });
      // where() needs an expression, so with nothing to filter on there is no where at all.
      if (view === "all" && !q && active.length === 0) return base;
      return base.where(({ o }) => {
        const tab = view === "open" ? eq(o.open, true) : view === "filled" ? eq(o.status, "FILLED") : view === "canceled" ? inArray(o.status, ["CANCELED", "REJECTED"]) : undefined;
        const text = q ? or(ilike(o.orderId, `%${q}%`), ilike(o.externalId, `%${q}%`), ilike(o.symbol, `%${q}%`)) : undefined;
        return dbWhere(o as never, active, now, [tab, text]);
      });
    },
  });

  // ---------- counts, choices and selection ----------

  const counts = useMemo(() => {
    const c: Record<View, number> = { open: 0, filled: 0, canceled: 0, all: all.length };
    for (const o of all) {
      if (isOpen(o.status)) c.open++;
      else if (o.status === "FILLED") c.filled++;
      else if (o.status === "CANCELED" || o.status === "REJECTED") c.canceled++;
    }
    return c;
  }, [all]);

  // Choices for the multi-select filters, with counts over every order.
  const facets = useMemo(() => {
    const out: Record<string, Facet[]> = {};
    const records = all.map(toOrderRecord);
    for (const [id, field] of Object.entries(MULTI)) {
      const n = new Map<string, number>();
      for (const r of records) n.set(String(r[field] ?? ""), (n.get(String(r[field] ?? "")) ?? 0) + 1);
      out[id] = [...n].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value));
    }
    return out;
  }, [all]);

  // Drop selections for orders that can no longer be canceled.
  useEffect(() => {
    const stale = Object.keys(selection).filter((id) => {
      const o = store.orders.get(id);
      return !o || !isActionable(o.status);
    });
    if (stale.length) setSelection((s) => Object.fromEntries(Object.entries(s).filter(([id]) => !stale.includes(id))));
  }, [all, selection]);

  const selectedIds = Object.keys(selection).filter((id) => selection[id]);
  const symbolFilter = (filters.find((f) => f.id === "symbol")?.value as string[] | undefined) ?? [];
  const setSymbolFilter = (v: string[] | undefined) => setFilters((fs) => [...fs.filter((f) => f.id !== "symbol"), ...(v?.length ? [{ id: "symbol", value: v }] : [])]);

  return (
    <Panel
      className="h-full"
      title={
        <span className="flex items-center gap-2">
          Orders
          <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] font-medium tracking-normal text-muted normal-case">{counts.open} open</span>
        </span>
      }
      actions={
        selectedIds.length > 0 && (
          <Button tone="danger" onClick={() => setConfirm(selectedIds)}>
            <Ban size={13} /> Cancel {selectedIds.length} selected
          </Button>
        )
      }
    >
      <DataTable<OrderRecord>
        id="orders"
        data={rows}
        columns={columns}
        getRowId={(o) => o.orderId}
        // Newest change first, so orders that were just modified, filled or canceled float to the top.
        defaultSorting={[{ id: "updated", desc: true }]}
        filters={filters}
        onFiltersChange={setFilters}
        manualFiltering
        facets={facets}
        rowSelection={selection}
        onRowSelectionChange={setSelection}
        canSelect={(o) => isActionable(o.status)}
        pageSize={50}
        total={all.length}
        flash={{ key: (o) => o.updatedNs, at: (o) => store.touchedAt.get(o.orderId) ?? 0 }}
        rowClassName={(o) => cx(focusOrderId === o.orderId && "bg-info-soft", !o.open && "opacity-75")}
        onRowClick={(o) => {
          setSymbol(o.symbol);
          setFocusOrderId(o.orderId);
        }}
        empty={all.length ? "No orders match these filters." : "No orders in the last 24 hours yet."}
        toolbar={
          <>
            <Segmented<View>
              value={view}
              onChange={setView}
              options={[
                { value: "open", label: `Open ${counts.open}` },
                { value: "filled", label: `Filled ${counts.filled}` },
                { value: "canceled", label: `Canceled/Rejected ${counts.canceled}` },
                { value: "all", label: `All ${counts.all}` },
              ]}
            />
            {/* The same filter as the Symbol column's. */}
            <Button size="sm" onClick={(e) => setSymbolMenu(symbolMenu ? undefined : e.currentTarget)} className={cx(symbolFilter.length > 0 && "border-info text-info")}>
              {symbolFilter.length === 0 ? "All symbols" : symbolFilter.length === 1 ? symbolFilter[0] : `${symbolFilter.length} symbols`}
              <ChevronDown size={12} />
            </Button>
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" />
              <input
                className="h-7 w-48 rounded border border-line bg-raised pr-2 pl-7 text-xs text-ink outline-none placeholder:text-faint focus:border-info"
                placeholder="Order ID, ext ID, symbol…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {selectedSymbol && !(symbolFilter.length === 1 && symbolFilter[0] === selectedSymbol) && (
              <Button tone="ghost" size="xs" onClick={() => setSymbolFilter([selectedSymbol])}>
                Only {selectedSymbol}
              </Button>
            )}
          </>
        }
      />

      {symbolMenu && (
        <Popover anchor={symbolMenu} onClose={() => setSymbolMenu(undefined)}>
          <FilterEditor label="Symbols" meta={{ kind: "multi" }} value={symbolFilter} onChange={(v) => setSymbolFilter(v as string[] | undefined)} facets={facets.symbol} />
        </Popover>
      )}
      {modifying && <ModifyDialog order={modifying} onClose={() => setModifying(undefined)} />}
      {confirm && (
        <ConfirmCancel
          title={`Cancel ${confirm.length} selected order${confirm.length === 1 ? "" : "s"}?`}
          body="This sends a cancel for each selected order. Orders can still fill while their cancel is in flight."
          pending={cancelMany.isPending}
          onClose={() => setConfirm(undefined)}
          onConfirm={() => cancelMany.mutate(confirm, { onSettled: () => setConfirm(undefined), onSuccess: () => setSelection({}) })}
        />
      )}
    </Panel>
  );
}

// Wall-clock time, refreshed every `everyMs` (0 = never, and reads as 0).
function useClock(everyMs: number): number {
  const [now, setNow] = useState(() => (everyMs ? Date.now() : 0));
  useEffect(() => {
    if (!everyMs) {
      setNow(0);
      return;
    }
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
