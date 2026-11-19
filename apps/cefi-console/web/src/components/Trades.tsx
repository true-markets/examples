import { eq, useLiveQuery } from "@tanstack/react-db";
import { createColumnHelper, type ColumnDef, type ColumnFiltersState } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useFillHistory } from "../api.ts";
import { fillsCollection, type FillRecord } from "../db.ts";
import { dateTime, nsToMs, price, qty, time, usd, when } from "../format.ts";
import { store, useFills, useMarket, type TapeTrade } from "../store.ts";
import { DataTable, idOf, type ColMeta } from "../table/DataTable.tsx";
import type { Facet } from "../table/FilterEditor.tsx";
import { dbWhere, isActive, type ActiveFilter, type FilterValue } from "../table/filters.ts";
import { useUi } from "../ui-state.tsx";
import { Empty, Panel, Segmented, SideText, cx } from "./ui.tsx";

export function Trades() {
  const [tab, setTab] = useState<"fills" | "tape">("fills");
  const [onlySymbol, setOnlySymbol] = useState(false);
  // These books trade rarely, so the tape can show every book at once.
  const [tapeScope, setTapeScope] = useState<"book" | "all">("all");
  const { symbol } = useUi();
  return (
    <Panel
      className="h-full"
      title={tab === "fills" ? "Your fills" : tapeScope === "all" ? "Market trades · all books" : `Market trades${symbol ? ` · ${symbol}` : ""}`}
      actions={
        <>
          {tab === "tape" && (
            <Segmented
              value={tapeScope}
              onChange={setTapeScope}
              options={[
                { value: "book", label: "This book" },
                { value: "all", label: "All books" },
              ]}
            />
          )}
          {tab === "fills" && symbol && (
            <label className="mr-1 flex items-center gap-1 text-[11px] text-muted">
              <input type="checkbox" checked={onlySymbol} onChange={(e) => setOnlySymbol(e.target.checked)} /> {symbol} only
            </label>
          )}
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "fills", label: "Fills" },
              { value: "tape", label: "Tape" },
            ]}
          />
        </>
      }
    >
      {tab === "fills" ? <Fills symbol={onlySymbol ? symbol : undefined} /> : <Tape scope={tapeScope} />}
    </Panel>
  );
}

const fcol = createColumnHelper<FillRecord>();
const fm = (meta: ColMeta) => meta;
const FILL_MULTI: Record<string, keyof FillRecord> = { symbol: "symbol", side: "side", liquidity: "liquidity" };

// Your fills, from a TanStack DB live query over the fills collection; the column filters and the
// "this book only" box become its where clause.
function Fills({ symbol }: { symbol?: string }) {
  useFillHistory();
  const all = useFills();
  const { setSymbol, setFocusOrderId } = useUi();
  const [filters, setFilters] = useState<ColumnFiltersState>([]);

  const columns = useMemo<ColumnDef<FillRecord, unknown>[]>(
    () =>
      [
        fcol.accessor("timeMs", {
          id: "time",
          header: "Time",
          size: 104,
          meta: fm({ label: "Time", filter: { kind: "since", field: "timeMs" } }),
          cell: (c) => <span className="num text-muted">{time(c.row.original.timestampNs)}</span>,
        }),
        fcol.accessor("symbol", { id: "symbol", header: "Symbol", size: 116, meta: fm({ label: "Symbol", filter: { kind: "multi" } }) }),
        fcol.accessor("side", { id: "side", header: "Side", size: 64, meta: fm({ label: "Side", filter: { kind: "multi" } }), cell: (c) => <SideText side={c.getValue()} /> }),
        fcol.accessor("priceN", {
          id: "price",
          header: "Price",
          size: 88,
          meta: fm({ label: "Price", align: "right", filter: { kind: "range", field: "priceN", unit: "$" } }),
          cell: (c) => <span className="num">{price(c.row.original.price)}</span>,
        }),
        fcol.accessor("qtyN", {
          id: "qty",
          header: "Qty",
          size: 76,
          meta: fm({ label: "Qty", align: "right", filter: { kind: "range", field: "qtyN" } }),
          cell: (c) => <span className="num">{qty(c.row.original.qty)}</span>,
        }),
        fcol.accessor("notionalN", {
          id: "notional",
          header: "Notional",
          size: 92,
          meta: fm({ label: "Notional", align: "right", filter: { kind: "range", field: "notionalN", unit: "$" } }),
          cell: (c) => <span className="num text-muted">{usd(c.getValue() as number)}</span>,
        }),
        fcol.accessor((f) => f.liquidity ?? "", {
          id: "liquidity",
          header: "Liq",
          size: 72,
          meta: fm({ label: "Liquidity", filter: { kind: "multi", field: "liquidity" } }),
          cell: (c) => <span className="text-muted">{c.row.original.liquidity ?? "—"}</span>,
        }),
        fcol.accessor("feeBpsN", {
          id: "feeBps",
          header: "Fee bps",
          size: 72,
          sortUndefined: "last",
          meta: fm({ label: "Fee bps", align: "right", filter: { kind: "range", field: "feeBpsN" } }),
          cell: (c) => <span className="num text-muted">{c.row.original.feeBps ?? "—"}</span>,
        }),
        fcol.accessor("orderId", {
          id: "orderId",
          header: "Order ID",
          size: 96,
          meta: fm({ label: "Order ID", hidden: true, filter: { kind: "text" } }),
          cell: (c) => (
            <span className="num text-faint" title={c.getValue()}>
              …{c.getValue().slice(-8)}
            </span>
          ),
        }),
      ] as ColumnDef<FillRecord, unknown>[],
    [],
  );

  const metaById = useMemo(() => Object.fromEntries(columns.map((c) => [idOf(c), (c.meta as ColMeta).filter])), [columns]);
  const filtersKey = JSON.stringify(filters);
  const active = useMemo<ActiveFilter[]>(
    () => filters.flatMap((f) => (metaById[f.id] && isActive(metaById[f.id]!.kind, f.value as FilterValue) ? [{ id: f.id, meta: metaById[f.id]!, value: f.value as FilterValue }] : [])),
    // filtersKey stands for the filters' contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtersKey, metaById],
  );
  const now = active.some((f) => f.meta.kind === "since") ? Math.floor(Date.now() / 10_000) * 10_000 : 0;

  const { data: rows = [] } = useLiveQuery({
    query: (q) => {
      const base = q.from({ f: fillsCollection });
      // where() needs an expression, so with nothing to filter on there is no where at all.
      if (!symbol && active.length === 0) return base;
      return base.where(({ f }) => dbWhere(f as never, active, now, [symbol ? eq(f.symbol, symbol) : undefined]));
    },
  });

  // Choices for the multi-select filters, with counts over every fill.
  const facets = useMemo(() => {
    const out: Record<string, Facet[]> = {};
    for (const [colId, field] of Object.entries(FILL_MULTI)) {
      const n = new Map<string, number>();
      for (const f of all) n.set(String(f[field as keyof typeof f] ?? ""), (n.get(String(f[field as keyof typeof f] ?? "")) ?? 0) + 1);
      out[colId] = [...n].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value));
    }
    return out;
  }, [all]);

  return (
    <DataTable<FillRecord>
      id="fills"
      data={rows}
      columns={columns}
      getRowId={(f) => f.id}
      defaultSorting={[{ id: "time", desc: true }]}
      filters={filters}
      onFiltersChange={setFilters}
      manualFiltering
      facets={facets}
      pageSize={100}
      total={all.length}
      onRowClick={(f) => {
        setSymbol(f.symbol);
        setFocusOrderId(f.orderId);
      }}
      empty={all.length ? "No fills match these filters." : "No fills in the last 24 hours."}
    />
  );
}

// Public trades as they happen. The exchange sends no history on subscribe, so each book starts
// with its last trade from the top-of-book snapshot (marked "earlier"); everything after that is live.
function Tape({ scope }: { scope: "book" | "all" }) {
  const { symbol, setSymbol } = useUi();
  useMarket();
  const all = scope === "all";
  const trades = all ? store.allTrades() : symbol ? (store.tape.get(symbol) ?? []) : [];
  // A print is yours when one of your fills has the same book, price and size within a few seconds
  // (live trades carry no exchange timestamp, so they are stamped on arrival).
  const yours = (t: TapeTrade) =>
    t.source === "live" &&
    store.fills.some(
      (f) => f.symbol === t.symbol && Number(f.price) === Number(t.price) && Number(f.qty) === Number(t.qty) && Math.abs(nsToMs(f.timestampNs) - nsToMs(t.timestampNs)) < 5_000,
    );
  if (!all && !symbol) return <Empty>Pick a symbol.</Empty>;
  const cols = all ? "grid-cols-[1fr_1.2fr_1fr_1fr_auto]" : "grid-cols-[1fr_1fr_1fr_auto]";
  return (
    <div className="h-full overflow-auto">
      <div className={cx("sticky top-0 grid gap-2 border-b border-line bg-panel px-3 py-1.5 text-[10px] font-semibold tracking-wider text-faint uppercase", cols)}>
        <span>Time</span>
        {all && <span>Book</span>}
        <span className="text-right">Price</span>
        <span className="text-right">Size</span>
        <span className="w-12 text-right">Aggr</span>
      </div>
      {trades.map((t) => {
        const mine = yours(t);
        const earlier = t.source === "last";
        return (
          <div
            key={t.id}
            className={cx("grid h-6 items-center gap-2 px-3", cols, mine && "bg-accent-soft", earlier && "opacity-60", all && "cursor-pointer hover:bg-raised")}
            onClick={all ? () => setSymbol(t.symbol) : undefined}
            title={earlier ? "The book's last trade before you opened the console" : undefined}
          >
            <span className="num truncate text-muted" title={dateTime(t.timestampNs)}>{earlier ? when(t.timestampNs) : time(t.timestampNs)}</span>
            {all && <span className="truncate text-xs">{t.symbol}</span>}
            <span className={cx("num text-right", earlier ? "text-ink" : t.side === "BUY" ? "text-buy" : "text-sell")}>{price(t.price)}</span>
            <span className="num text-right">{qty(t.qty)}</span>
            <span className={cx("w-12 text-right text-[10px] font-semibold", earlier ? "text-faint" : t.side === "BUY" ? "text-buy" : "text-sell")}>
              {mine ? "YOU" : earlier ? "EARLIER" : t.side}
            </span>
          </div>
        );
      })}
      {trades.length === 0 && (
        <Empty>
          No trades yet. The exchange doesn't send trade history, so prints appear here as they happen; these books often go minutes between trades.
        </Empty>
      )}
    </div>
  );
}
