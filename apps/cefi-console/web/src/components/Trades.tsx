import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useState } from "react";
import type { FillRow } from "../../../shared/api.ts";
import { compareNs } from "../../../shared/orders.ts";
import { useFillHistory } from "../api.ts";
import { dateTime, nsToMs, price, qty, time, usd, when } from "../format.ts";
import { store, useFills, useMarket, type TapeTrade } from "../store.ts";
import { useUi } from "../ui-state.tsx";
import { Empty, Panel, Segmented, SideText, cx } from "./ui.tsx";

const col = createColumnHelper<FillRow>();

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

function Fills({ symbol }: { symbol?: string }) {
  useFillHistory();
  const fills = useFills();
  const { setSymbol, setFocusOrderId } = useUi();
  const [sorting, setSorting] = useState<SortingState>([{ id: "time", desc: true }]);
  const columns = useMemo(
    () => [
      col.accessor("timestampNs", { id: "time", header: "Time", cell: (c) => <span className="num text-muted">{time(c.getValue())}</span>, sortingFn: (a, b) => compareNs(a.original.timestampNs, b.original.timestampNs) }),
      col.accessor("symbol", { header: "Symbol", filterFn: "equalsString" }),
      col.accessor("side", { header: "Side", cell: (c) => <SideText side={c.getValue()} /> }),
      col.accessor("price", { header: "Price", cell: (c) => <span className="num">{price(c.getValue())}</span>, sortingFn: (a, b) => Number(a.original.price) - Number(b.original.price), meta: { right: true } }),
      col.accessor("qty", { header: "Qty", cell: (c) => <span className="num">{qty(c.getValue())}</span>, sortingFn: (a, b) => Number(a.original.qty) - Number(b.original.qty), meta: { right: true } }),
      col.accessor((f) => Number(f.price) * Number(f.qty), { id: "notional", header: "Notional", cell: (c) => <span className="num text-muted">{usd(c.getValue())}</span>, meta: { right: true } }),
      col.accessor("liquidity", { header: "Liq", cell: (c) => <span className="text-muted">{c.getValue() ?? "—"}</span> }),
      col.accessor("feeBps", { header: "Fee bps", cell: (c) => <span className="num text-muted">{c.getValue() ?? "—"}</span>, meta: { right: true } }),
    ],
    [],
  );
  // Memoized: a new filters array on every render makes TanStack re-filter and auto-reset the
  // page index, which re-renders, which makes a new array... a render loop.
  const columnFilters = useMemo(() => (symbol ? [{ id: "symbol", value: symbol }] : []), [symbol]);
  const table = useReactTable({
    data: fills,
    columns,
    state: { sorting, columnFilters },
    autoResetPageIndex: false,
    onSortingChange: setSorting,
    getRowId: (f) => f.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });
  const rows = table.getRowModel().rows.slice(0, 300);

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead className="sticky top-0 bg-panel">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const right = (h.column.columnDef.meta as { right?: boolean } | undefined)?.right;
                return (
                  <th
                    key={h.id}
                    onClick={h.column.getToggleSortingHandler()}
                    className={cx("h-7 cursor-pointer border-b border-line px-2 text-[10px] font-semibold tracking-wider text-faint uppercase select-none hover:text-ink", right ? "text-right" : "text-left")}
                  >
                    <span className={cx("inline-flex items-center gap-1", right && "flex-row-reverse")}>
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {h.column.getIsSorted() === "asc" && <ArrowUp size={11} />}
                      {h.column.getIsSorted() === "desc" && <ArrowDown size={11} />}
                    </span>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="cursor-pointer hover:bg-raised"
              onClick={() => {
                setSymbol(r.original.symbol);
                setFocusOrderId(r.original.orderId);
              }}
            >
              {r.getVisibleCells().map((c) => (
                <td key={c.id} className={cx("h-7 border-b border-line/60 px-2 whitespace-nowrap", (c.column.columnDef.meta as { right?: boolean } | undefined)?.right && "text-right")}>
                  {flexRender(c.column.columnDef.cell, c.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <Empty>No fills in the last 24 hours.</Empty>}
    </div>
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
