import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnFiltersState,
  type FilterFn,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, Ban, Pencil, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import type { OrderRow } from "../../../shared/api.ts";
import { compareNs, isActionable, isOpen } from "../../../shared/orders.ts";
import type { OrderStatus } from "../../../shared/wire.ts";
import { useCancelAll, useCancelMany, useCancelOrder, useOrderHistory } from "../api.ts";
import { price, qty, shortId, time } from "../format.ts";
import { store, useOrders } from "../store.ts";
import { useUi } from "../ui-state.tsx";
import { ConfirmCancel } from "./ConfirmCancel.tsx";
import { ModifyDialog } from "./ModifyDialog.tsx";
import { Button, Empty, Panel, Segmented, SideText, StatusBadge, cx, selectClass } from "./ui.tsx";

type View = "open" | "filled" | "canceled" | "all";

const VIEW_MATCH: Record<View, (s: OrderStatus) => boolean> = {
  open: isOpen,
  filled: (s) => s === "FILLED",
  canceled: (s) => s === "CANCELED" || s === "REJECTED",
  all: () => true,
};

const ns = (a: string, b: string) => compareNs(a, b);
const num = (a?: string, b?: string) => Number(a ?? 0) - Number(b ?? 0);

const col = createColumnHelper<OrderRow>();

// Whole percents, with one decimal under 10% so a small partial fill doesn't read as 0%.
function fillPct(p: number): string {
  if (p <= 0) return "0%";
  if (p >= 1) return "100%";
  const v = p * 100;
  return v < 10 ? `${Math.max(0.1, Math.floor(v * 10) / 10)}%` : `${Math.floor(v)}%`;
}

// Keeps the row actions in view however wide the table scrolls.
const STICKY_RIGHT = "sticky right-0 bg-panel group-hover:bg-raised shadow-[-8px_0_8px_-8px_rgb(0_0_0/0.4)]";

// A row that flashes when its order changes. The animation is started from an effect rather than
// by re-keying, so the row (and the button under your cursor) is never re-created mid-click.
function FlashRow({ updatedNs, touchedAt, children, ...rest }: { updatedNs: string; touchedAt: number } & ComponentProps<"tr">) {
  const ref = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (Date.now() - touchedAt > 1_500) return;
    ref.current?.animate([{ backgroundColor: "var(--color-accent-soft)" }, { backgroundColor: "transparent" }], { duration: 1_400, easing: "ease-out" });
  }, [updatedNs, touchedAt]);
  return (
    <tr ref={ref} {...rest}>
      {children}
    </tr>
  );
}

const viewFilter: FilterFn<OrderRow> = (row, _id, view: View) => VIEW_MATCH[view](row.original.status);

export function OrdersTable() {
  useOrderHistory();
  const orders = useOrders();
  const { symbol: selectedSymbol, setSymbol, setFocusOrderId, focusOrderId } = useUi();
  const { mutate: cancelOrder } = useCancelOrder();
  const cancelMany = useCancelMany();
  const cancelAll = useCancelAll();

  const [view, setView] = useState<View>("open");
  const [symbolFilter, setSymbolFilter] = useState<string>("");
  const [sideFilter, setSideFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  // Newest change first, so orders that were just modified, filled or canceled float to the top.
  const [sorting, setSorting] = useState<SortingState>([{ id: "updated", desc: true }]);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [modifying, setModifying] = useState<OrderRow>();
  const [confirm, setConfirm] = useState<{ kind: "symbol"; symbol: string; count: number } | { kind: "selected"; ids: string[] }>();

  const counts = useMemo(() => {
    const c: Record<View, number> = { open: 0, filled: 0, canceled: 0, all: orders.length };
    for (const o of orders) {
      if (VIEW_MATCH.open(o.status)) c.open++;
      else if (o.status === "FILLED") c.filled++;
      else if (VIEW_MATCH.canceled(o.status)) c.canceled++;
    }
    return c;
  }, [orders]);

  const symbols = useMemo(() => [...new Set(orders.map((o) => o.symbol))].sort(), [orders]);

  const columns = useMemo(
    () => [
      col.display({
        id: "select",
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
        size: 28,
      }),
      col.accessor("updatedNs", { id: "updated", header: "Updated", cell: (c) => <span className="num text-muted">{time(c.getValue())}</span>, sortingFn: (a, b) => ns(a.original.updatedNs, b.original.updatedNs) }),
      col.accessor("symbol", { header: "Symbol", cell: (c) => <span className="font-medium">{c.getValue()}</span> }),
      col.accessor("side", { header: "Side", cell: (c) => <SideText side={c.getValue()} /> }),
      col.accessor("type", { header: "Type", cell: (c) => <span className="text-muted">{c.getValue()}</span> }),
      col.accessor("tif", { header: "TIF", cell: (c) => <span className="text-muted">{c.getValue()}</span> }),
      col.accessor("price", { header: "Price", cell: (c) => <span className="num">{price(c.getValue())}</span>, sortingFn: (a, b) => num(a.original.price, b.original.price), meta: { align: "right" } }),
      col.accessor("qty", { header: "Qty", cell: (c) => <span className="num">{qty(c.getValue())}</span>, sortingFn: (a, b) => num(a.original.qty, b.original.qty), meta: { align: "right" } }),
      col.accessor((o) => (Number(o.qty) ? Number(o.executedQty) / Number(o.qty) : 0), {
        id: "filled",
        header: "Filled",
        cell: (c) => {
          const o = c.row.original;
          const pct = c.getValue();
          return (
            <div className="flex items-center justify-end gap-2">
              <span className="num text-muted">{qty(o.executedQty)}</span>
              <div className="h-1 w-12 overflow-hidden rounded bg-raised">
                <div className={cx("h-full", pct >= 1 ? "bg-buy" : "bg-info")} style={{ width: `${Math.min(100, pct * 100)}%` }} />
              </div>
              <span className={cx("num w-10 text-right text-[11px]", pct >= 1 ? "text-buy" : pct > 0 ? "text-ink" : "text-faint")}>{fillPct(pct)}</span>
            </div>
          );
        },
        meta: { align: "right" },
      }),
      col.accessor("leavesQty", { header: "Leaves", cell: (c) => <span className="num">{qty(c.getValue())}</span>, sortingFn: (a, b) => num(a.original.leavesQty, b.original.leavesQty), meta: { align: "right" } }),
      col.accessor("vwap", { header: "Avg px", cell: (c) => <span className="num text-muted">{price(c.getValue())}</span>, sortingFn: (a, b) => num(a.original.vwap, b.original.vwap), meta: { align: "right" } }),
      col.accessor("status", {
        header: "Status",
        // Filters by the selected view (open, filled, ...) rather than by exact value.
        filterFn: viewFilter,
        cell: (c) => <StatusBadge status={c.getValue()} partial={Number(c.row.original.executedQty) > 0} />,
      }),
      col.accessor("lastEvent", {
        header: "Event",
        cell: (c) => (
          <span className="text-muted" title={c.row.original.text}>
            {c.getValue() ?? "—"}
            {c.row.original.text && <span className="ml-1 text-sell">•</span>}
          </span>
        ),
      }),
      col.accessor("orderId", { header: "Order ID", cell: (c) => <span className="num text-faint" title={c.getValue()}>{shortId(c.getValue())}</span> }),
      col.accessor("externalId", { header: "Ext ID", cell: (c) => <span className="num text-faint" title={c.getValue()}>{c.getValue() ?? "—"}</span> }),
      col.accessor("createdNs", { id: "created", header: "Created", cell: (c) => <span className="num text-faint">{time(c.getValue())}</span>, sortingFn: (a, b) => ns(a.original.createdNs, b.original.createdNs) }),
      col.display({
        id: "actions",
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
    ],
    // Keep columns stable: flexRender treats cell functions as components, so new ones would re-mount every cell.
    [cancelOrder],
  );

  const columnFilters = useMemo<ColumnFiltersState>(() => {
    const f: ColumnFiltersState = [{ id: "status", value: view }];
    if (symbolFilter) f.push({ id: "symbol", value: symbolFilter });
    if (sideFilter) f.push({ id: "side", value: sideFilter });
    return f;
  }, [view, symbolFilter, sideFilter]);

  const table = useReactTable({
    data: orders,
    columns,
    state: { sorting, columnFilters, globalFilter: search, rowSelection: selection },
    getRowId: (o) => o.orderId,
    enableRowSelection: (row) => isActionable(row.original.status),
    onRowSelectionChange: setSelection,
    onSortingChange: setSorting,
    globalFilterFn: (row, _id, q: string) => {
      const o = row.original;
      const needle = q.trim().toLowerCase();
      return !needle || [o.orderId, o.externalId, o.symbol, o.status].some((v) => v?.toLowerCase().includes(needle));
    },
    defaultColumn: { filterFn: "equalsString" },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    autoResetPageIndex: false,
    initialState: { pagination: { pageSize: 50 } },
  });

  // Drop selections for orders that are no longer actionable.
  useEffect(() => {
    const stale = Object.keys(selection).filter((id) => {
      const o = store.orders.get(id);
      return !o || !isActionable(o.status);
    });
    if (stale.length) setSelection((s) => Object.fromEntries(Object.entries(s).filter(([id]) => !stale.includes(id))));
  }, [orders, selection]);

  const selectedIds = Object.keys(selection).filter((id) => selection[id]);
  const scopeSymbol = symbolFilter || undefined;
  const openInScope = scopeSymbol ? orders.filter((o) => o.symbol === scopeSymbol && isActionable(o.status)).length : 0;

  return (
    <Panel
      className="h-full"
      title={
        <span className="flex items-center gap-2">
          Orders
          <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] font-medium text-muted normal-case tracking-normal">{counts.open} open</span>
        </span>
      }
      actions={
        <>
          {selectedIds.length > 0 && (
            <Button tone="danger" onClick={() => setConfirm({ kind: "selected", ids: selectedIds })}>
              <Ban size={13} /> Cancel {selectedIds.length} selected
            </Button>
          )}
          {scopeSymbol && (
            <Button tone="danger" disabled={openInScope === 0} onClick={() => setConfirm({ kind: "symbol", symbol: scopeSymbol, count: openInScope })}>
              <Ban size={13} /> Cancel all {scopeSymbol}
            </Button>
          )}
        </>
      }
    >
      <div className="flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <Segmented<View>
            value={view}
            onChange={(v) => {
              setView(v);
              table.setPageIndex(0);
            }}
            options={[
              { value: "open", label: `Open ${counts.open}` },
              { value: "filled", label: `Filled ${counts.filled}` },
              { value: "canceled", label: `Canceled/Rejected ${counts.canceled}` },
              { value: "all", label: `All ${counts.all}` },
            ]}
          />
          <select className={selectClass} value={symbolFilter} onChange={(e) => setSymbolFilter(e.target.value)} aria-label="Symbol filter">
            <option value="">All symbols</option>
            {symbols.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select className={selectClass} value={sideFilter} onChange={(e) => setSideFilter(e.target.value)} aria-label="Side filter">
            <option value="">Both sides</option>
            <option value="BUY">Buy</option>
            <option value="SELL">Sell</option>
          </select>
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" />
            <input
              className="h-7 w-48 rounded border border-line bg-raised pr-2 pl-7 text-xs text-ink outline-none placeholder:text-faint focus:border-info"
              placeholder="Order ID, ext ID, symbol…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {selectedSymbol && symbolFilter !== selectedSymbol && (
            <Button tone="ghost" size="xs" onClick={() => setSymbolFilter(selectedSymbol)}>
              Only {selectedSymbol}
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-10 bg-panel">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => {
                    const sorted = h.column.getIsSorted();
                    const right = (h.column.columnDef.meta as { align?: string } | undefined)?.align === "right";
                    return (
                      <th
                        key={h.id}
                        className={cx(
                          "h-8 border-b border-line px-2 text-[10px] font-semibold tracking-wider whitespace-nowrap text-faint uppercase select-none",
                          right ? "text-right" : "text-left",
                          h.column.getCanSort() && "cursor-pointer hover:text-ink",
                          h.column.id === "actions" && STICKY_RIGHT,
                        )}
                        onClick={h.column.getToggleSortingHandler()}
                      >
                        <span className={cx("inline-flex items-center gap-1", right && "flex-row-reverse")}>
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sorted === "asc" && <ArrowUp size={11} />}
                          {sorted === "desc" && <ArrowDown size={11} />}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => {
                const o = row.original;
                return (
                  <FlashRow
                    key={row.id}
                    updatedNs={o.updatedNs}
                    touchedAt={store.touchedAt.get(o.orderId) ?? 0}
                    className={cx("group cursor-pointer hover:bg-raised", focusOrderId === o.orderId && "bg-info-soft", !isOpen(o.status) && "opacity-75")}
                    onClick={() => {
                      setSymbol(o.symbol);
                      setFocusOrderId(o.orderId);
                    }}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const right = (cell.column.columnDef.meta as { align?: string } | undefined)?.align === "right";
                      return (
                        <td
                          key={cell.id}
                          className={cx(
                            "h-8 border-b border-line/60 px-2 whitespace-nowrap",
                            right && "text-right",
                            cell.column.id === "actions" && STICKY_RIGHT,
                          )}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      );
                    })}
                  </FlashRow>
                );
              })}
            </tbody>
          </table>
          {table.getRowModel().rows.length === 0 && <Empty>{orders.length ? "No orders match these filters." : "No orders in the last 24 hours yet."}</Empty>}
        </div>

        <footer className="flex h-9 shrink-0 items-center gap-2 border-t border-line px-3 text-[11px] text-muted">
          <span>
            {table.getFilteredRowModel().rows.length} of {orders.length} orders
          </span>
          <span className="ml-auto">
            Page {table.getState().pagination.pageIndex + 1} of {Math.max(1, table.getPageCount())}
          </span>
          <Button size="xs" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>
            Prev
          </Button>
          <Button size="xs" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
            Next
          </Button>
        </footer>
      </div>

      {modifying && <ModifyDialog order={modifying} onClose={() => setModifying(undefined)} />}
      {confirm && (
        <ConfirmCancel
          title={confirm.kind === "symbol" ? `Cancel all ${confirm.symbol} orders?` : `Cancel ${confirm.ids.length} selected orders?`}
          body={
            confirm.kind === "symbol"
              ? `This sends a cancel for each of your ${confirm.count} open ${confirm.symbol} orders, a few at a time. Orders can still fill while their cancel is in flight.`
              : "This sends a cancel for each selected order. Orders can still fill while their cancel is in flight."
          }
          pending={cancelAll.isPending || cancelMany.isPending}
          onClose={() => setConfirm(undefined)}
          onConfirm={() => {
            const done = { onSettled: () => setConfirm(undefined) };
            if (confirm.kind === "symbol") cancelAll.mutate(confirm.symbol, done);
            else cancelMany.mutate(confirm.ids, { ...done, onSuccess: () => setSelection({}) });
          }}
        />
      )}
    </Panel>
  );
}
