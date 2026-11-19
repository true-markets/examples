import { FoldVertical, LayoutGrid } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { Instrument, OrderRow } from "../../../shared/api.ts";
import { isOpen } from "../../../shared/orders.ts";
import { isListed, useInstruments } from "../api.ts";
import { compact, price, usd } from "../format.ts";
import { store, useMarket, useOrders } from "../store.ts";
import { useUi } from "../ui-state.tsx";
import { cx, selectClass } from "./ui.tsx";

const COLLAPSED_KEY = "cefi-console:markets-collapsed";

// The market bar. Open, it shows one tile per instrument in two rows that fit the width: live top
// of book and how many of your orders rest there. Collapsed, it is one line: a summary of your
// orders across every book, then the selected book's top of book and a picker to switch books. Disabled
// instruments are left out unless you still have orders on one.
export function Markets() {
  const { data: instruments } = useInstruments();
  const { symbol, setSymbol } = useUi();
  useMarket();
  const orders = useOrders();
  const [collapsed, setCollapsedState] = useState(() => readFlag(COLLAPSED_KEY));
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    writeFlag(COLLAPSED_KEY, v);
  };

  const open = useMemo(() => summarize(orders), [orders]);
  const shown = (instruments ?? []).filter((i) => isListed(i) || (open.bySymbol.get(i.symbol) ?? 0) > 0);

  return (
    <div className="flex items-stretch gap-1.5">
      <div className="min-w-0 flex-1">
        {collapsed ? (
          <Summary shown={shown} symbol={symbol} setSymbol={setSymbol} open={open} />
        ) : (
          <Tiles shown={shown} symbol={symbol} setSymbol={setSymbol} openBySymbol={open.bySymbol} />
        )}
      </div>
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-6 shrink-0 items-center justify-center rounded-md border border-line bg-panel text-muted hover:border-faint hover:text-ink"
        title={collapsed ? "Show all books" : "Collapse to a summary"}
        aria-label={collapsed ? "Show all books" : "Collapse books"}
      >
        {/* Not a chevron, so it doesn't read as another dropdown next to the book picker. */}
        {collapsed ? <LayoutGrid size={14} /> : <FoldVertical size={14} />}
      </button>
    </div>
  );
}

interface OpenSummary {
  bySymbol: Map<string, number>;
  count: number;
  bidUsd: number;
  askUsd: number;
}

// Your open orders: how many per book, and what rests on each side at the orders' own prices.
function summarize(orders: OrderRow[]): OpenSummary {
  const s: OpenSummary = { bySymbol: new Map(), count: 0, bidUsd: 0, askUsd: 0 };
  for (const o of orders) {
    if (!isOpen(o.status)) continue;
    s.count++;
    s.bySymbol.set(o.symbol, (s.bySymbol.get(o.symbol) ?? 0) + 1);
    const notional = Number(o.leavesQty) * Number(o.price ?? 0);
    if (o.side === "BUY") s.bidUsd += notional;
    else s.askUsd += notional;
  }
  return s;
}

function Tiles({ shown, symbol, setSymbol, openBySymbol }: { shown: Instrument[]; symbol?: string; setSymbol: (s: string) => void; openBySymbol: Map<string, number> }) {
  const columns = Math.max(1, Math.ceil(shown.length / 2));
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {shown.map((i) => {
        const e = store.ebbo.get(i.symbol);
        const live = store.instruments.get(i.symbol);
        const status = live?.status ?? i.status;
        const open = openBySymbol.get(i.symbol) ?? 0;
        return (
          <button
            key={i.symbol}
            type="button"
            title={open > 0 ? `${open} open order${open === 1 ? "" : "s"}` : undefined}
            onClick={() => setSymbol(i.symbol)}
            className={cx(
              "min-w-0 rounded-md border bg-panel px-2.5 py-1.5 text-left transition hover:border-faint",
              symbol === i.symbol ? "border-info ring-1 ring-info/40" : "border-line",
            )}
          >
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-semibold">{i.symbol}</span>
              {status !== "ACTIVE" && <span className="shrink-0 rounded bg-accent-soft px-1 text-[9px] font-semibold text-accent">{status}</span>}
              {open > 0 && <span className="ml-auto shrink-0 rounded bg-accent-soft px-1.5 text-[10px] font-semibold text-accent">{open} open</span>}
            </div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="num text-[13px] font-medium">{price(e?.info.last_trade?.price ?? i.referencePrice)}</span>
              <span className="truncate text-[10px] text-faint">vol {compact(live?.stats?.last_24hr_notional ?? i.notional24h)}</span>
            </div>
            <div className="num flex gap-1.5 truncate text-[11px]">
              <span className="text-buy">{price(e?.info.best_bid?.price)}</span>
              <span className="text-faint">/</span>
              <span className="text-sell">{price(e?.info.best_ask?.price)}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Summary({ shown, symbol, setSymbol, open }: { shown: Instrument[]; symbol?: string; setSymbol: (s: string) => void; open: OpenSummary }) {
  const e = symbol ? store.ebbo.get(symbol) : undefined;
  const bid = Number(e?.info.best_bid?.price ?? 0);
  const ask = Number(e?.info.best_ask?.price ?? 0);
  const spreadBps = bid > 0 && ask > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 10_000 : undefined;
  const mine = symbol ? (open.bySymbol.get(symbol) ?? 0) : 0;
  // Totals across every book on the left; the selected book, ending in its picker, on the right,
  // next to the order book it controls. Every number sits in a fixed-width slot (monospace digits,
  // right-aligned), so a digit coming or going doesn't push its neighbours around.
  return (
    <div className="flex h-9 items-center gap-4 overflow-hidden rounded-md border border-line bg-panel px-2 text-xs whitespace-nowrap">
      <span className="flex items-baseline gap-4 pl-1 text-muted">
        <span>
          <Slot ch={2} className="text-ink">
            {shown.length}
          </Slot>{" "}
          books
        </span>
        <span>
          <Slot ch={3} className="text-ink">
            {open.count}
          </Slot>{" "}
          open orders
        </span>
        <span title="Your open orders across every book, at their limit prices">
          resting bids{" "}
          <Slot ch={9} className="text-buy">
            {usd(open.bidUsd)}
          </Slot>{" "}
          · asks{" "}
          <Slot ch={9} className="text-sell">
            {usd(open.askUsd)}
          </Slot>
        </span>
      </span>

      <span className="ml-auto flex items-center gap-4">
        {/* Keeps its place at zero, so orders coming and going don't shift the prices beside it. */}
        <span className={cx("min-w-[11ch] rounded bg-accent-soft px-1.5 text-center text-[10px] font-semibold text-accent", mine === 0 && "invisible")}>
          {mine} open here
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-[10px] text-faint uppercase">Last</span>
          <Slot ch={8} className="text-[13px] font-medium">
            {price(e?.info.last_trade?.price)}
          </Slot>
        </span>
        <span className="flex items-baseline gap-1.5">
          <Slot ch={8} className="text-buy">
            {price(e?.info.best_bid?.price)}
          </Slot>
          <span className="text-faint">/</span>
          <Slot ch={8} align="left" className="text-sell">
            {price(e?.info.best_ask?.price)}
          </Slot>
          <span className="text-[11px] text-muted">
            <Slot ch={5}>{spreadBps !== undefined ? spreadBps.toFixed(1) : "—"}</Slot> bps
          </span>
        </span>
        {/* A fixed width too, so switching to a longer symbol doesn't move everything left. */}
        <select className={cx(selectClass, "w-52 font-semibold")} value={symbol ?? ""} onChange={(ev) => setSymbol(ev.target.value)} aria-label="Book">
          {shown.map((i) => {
            const n = open.bySymbol.get(i.symbol) ?? 0;
            return (
              <option key={i.symbol} value={i.symbol}>
                {i.symbol}
                {n ? ` · ${n} open` : ""}
              </option>
            );
          })}
        </select>
      </span>
    </div>
  );
}

// A number in a slot a fixed number of characters wide. With monospace, tabular digits, its width
// no longer depends on how many digits it has. Sized for typical values (prices up to 9,999.99,
// totals up to $9,999.99); a longer number just widens its slot.
function Slot({ ch, align = "right", className, children }: { ch: number; align?: "left" | "right"; className?: string; children: ReactNode }) {
  return (
    <span className={cx("num inline-block", align === "right" ? "text-right" : "text-left", className)} style={{ minWidth: `${ch}ch` }}>
      {children}
    </span>
  );
}

// localStorage can be missing or throw; the bar then just starts open.
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    // not remembered
  }
}
