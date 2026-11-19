import { X } from "lucide-react";
import { useMemo, useState } from "react";
import type { OrderRow } from "../../../shared/api.ts";
import { canonical, type BookLevel } from "../../../shared/book.ts";
import { isActionable, isOpen } from "../../../shared/orders.ts";
import { useCancelMany } from "../api.ts";
import { decimalsOf, price as fmtPrice, qty as fmtQty, usd } from "../format.ts";
import { store, useMarket, useOrders } from "../store.ts";
import { useUi } from "../ui-state.tsx";
import { ConfirmCancel } from "./ConfirmCancel.tsx";
import { Empty, Panel, Segmented, cx } from "./ui.tsx";

const DEPTHS = ["10", "20", "50"] as const;

type Unit = "qty" | "usd";
const UNIT_KEY = "cefi-console:book-unit";

// localStorage can be missing or throw; the book then just starts in quantity.
function readUnit(): Unit {
  try {
    return localStorage.getItem(UNIT_KEY) === "usd" ? "usd" : "qty";
  } catch {
    return "qty";
  }
}

function writeUnit(u: Unit): void {
  try {
    localStorage.setItem(UNIT_KEY, u);
  } catch {
    // not remembered
  }
}

interface Mine {
  qty: number;
  orders: OrderRow[];
}

// The L2 book for the selected symbol with your resting orders marked on their levels, so you can
// see where you sit in the queue and how much of each level is yours.
export function OrderBook() {
  const { symbol, prefillTicket, focusOrderId } = useUi();
  useMarket();
  const orders = useOrders();
  const [depth, setDepth] = useState<(typeof DEPTHS)[number]>("20");
  // Show Yours, Size and Total as quantity, or as USD (quantity × the level's price).
  const [unit, setUnitState] = useState<Unit>(() => readUnit());
  const setUnit = (u: Unit) => {
    setUnitState(u);
    writeUnit(u);
  };
  const amount = (qty: number, px: number) => (unit === "usd" ? qty * px : qty);
  const fmtAmount = (v: number) => (unit === "usd" ? usd(v) : fmtQty(v));
  const [confirm, setConfirm] = useState<OrderRow[]>();
  const cancelMany = useCancelMany();

  const book = symbol ? store.books.get(symbol) : undefined;
  const { bids, asks } = book?.levels() ?? { bids: [], asks: [] };
  const n = Number(depth);
  const shownBids = bids.slice(0, n);
  const shownAsks = asks.slice(0, n);

  // Your open orders on this symbol, by side and price level.
  const mine = useMemo(() => {
    const m = { BUY: new Map<string, Mine>(), SELL: new Map<string, Mine>() };
    for (const o of orders) {
      if (o.symbol !== symbol || !isOpen(o.status) || !o.price) continue;
      const key = canonical(o.price);
      const level = m[o.side].get(key) ?? { qty: 0, orders: [] };
      level.qty += Number(o.leavesQty);
      level.orders.push(o);
      m[o.side].set(key, level);
    }
    return m;
  }, [orders, symbol]);

  // Your orders priced past the levels shown.
  const deeper = useMemo(() => {
    const lastBid = shownBids.at(-1)?.price ?? Infinity;
    const lastAsk = shownAsks.at(-1)?.price ?? -Infinity;
    let count = 0;
    for (const [p, l] of mine.BUY) if (Number(p) < lastBid) count += l.orders.length;
    for (const [p, l] of mine.SELL) if (Number(p) > lastAsk) count += l.orders.length;
    return count;
  }, [mine, shownBids, shownAsks]);

  // Depth bars scale with whichever unit is on screen.
  const maxSize = Math.max(1e-12, ...shownBids.map((l) => amount(l.qty, l.price)), ...shownAsks.map((l) => amount(l.qty, l.price)));
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined;
  const mid = spread !== undefined ? (bestAsk! + bestBid!) / 2 : undefined;
  // Show computed prices at the book's own precision (one more digit for the mid).
  const pxDecimals = Math.max(decimalsOf(bids[0]?.priceText ?? ""), decimalsOf(asks[0]?.priceText ?? ""));
  // Your resting size per side, as quantity and as notional at each order's own price (quote ≈ USD).
  const resting = (side: "BUY" | "SELL") => {
    let qty = 0;
    let notional = 0;
    for (const [px, l] of mine[side]) {
      qty += l.qty;
      notional += l.qty * Number(px);
    }
    return { qty, notional };
  };
  const myBids = resting("BUY");
  const myAsks = resting("SELL");

  const row = (l: BookLevel, side: "BUY" | "SELL", cum: number) => {
    const my = mine[side].get(canonical(l.priceText));
    const share = my ? Math.min(1, my.qty / l.qty) : 0;
    const focused = my?.orders.some((o) => o.orderId === focusOrderId);
    return (
      <div
        key={`${side}${l.priceText}`}
        className={cx(
          "group relative grid h-[22px] cursor-pointer grid-cols-[1fr_1fr_1fr_1fr] items-center px-3 hover:bg-raised",
          my && "bg-accent-soft/60",
          focused && "outline outline-1 -outline-offset-1 outline-accent",
        )}
        onClick={() => prefillTicket({ price: l.priceText, side: side === "BUY" ? "SELL" : "BUY" })}
        title="Click to use this price in the order ticket"
      >
        {/* Depth bar, and the slice of it that is yours. */}
        <div className={cx("absolute inset-y-0.5 right-0", side === "BUY" ? "bg-buy-soft" : "bg-sell-soft")} style={{ width: `${(amount(l.qty, l.price) / maxSize) * 100}%` }}>
          {my && <div className="absolute inset-y-0 right-0 bg-accent/40" style={{ width: `${share * 100}%` }} />}
        </div>
        <div className="relative flex items-center gap-1">
          {my && (
            <>
              <span className="num font-semibold text-accent" title={my.orders.map((o) => `${o.orderId}  ${o.leavesQty}`).join("\n")}>
                {fmtAmount(amount(my.qty, l.price))}
                {my.orders.length > 1 && <span className="text-[10px] opacity-75"> ×{my.orders.length}</span>}
              </span>
              <button
                type="button"
                className="hidden rounded p-0.5 text-muted group-hover:inline-flex hover:bg-sell-soft hover:text-sell"
                title="Cancel your orders at this price"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirm(my.orders.filter((o) => isActionable(o.status)));
                }}
              >
                <X size={11} />
              </button>
            </>
          )}
        </div>
        <span className={cx("num relative text-right font-medium", side === "BUY" ? "text-buy" : "text-sell")}>{fmtPrice(l.priceText)}</span>
        <span className="num relative text-right">{fmtAmount(amount(l.qty, l.price))}</span>
        <span className="num relative text-right text-muted">{fmtAmount(cum)}</span>
      </div>
    );
  };

  const cumulative = (levels: BookLevel[]) => {
    let c = 0;
    return levels.map((l) => (c += amount(l.qty, l.price)));
  };
  const askCum = cumulative(shownAsks);
  const bidCum = cumulative(shownBids);

  return (
    <Panel
      className="h-full"
      title={symbol ? `Book · ${symbol}` : "Book"}
      actions={
        <>
          <Segmented
            value={unit}
            onChange={setUnit}
            options={[
              { value: "qty", label: "Qty" },
              { value: "usd", label: "USD" },
            ]}
          />
          <Segmented value={depth} onChange={setDepth} options={DEPTHS.map((d) => ({ value: d, label: d }))} />
        </>
      }
    >
      {!symbol || !book ? (
        <Empty>{symbol ? "Waiting for the book snapshot…" : "Pick a symbol."}</Empty>
      ) : (
        <div className="flex h-full flex-col">
          <div className="grid shrink-0 grid-cols-[1fr_1fr_1fr_1fr] px-3 py-1 text-[10px] font-semibold tracking-wider text-faint uppercase">
            <span>Yours</span>
            <span className="text-right">Price</span>
            <span className="text-right">{unit === "usd" ? "Size $" : "Size"}</span>
            <span className="text-right">{unit === "usd" ? "Total $" : "Total"}</span>
          </div>
          {/* The mid row is pinned to the vertical middle: asks fill the half above it with the best ask
              touching it, bids the half below. Each half scrolls on its own, so levels coming and going
              never move the mid. flex-col-reverse keeps the asks' scroll anchored at the best ask. */}
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 basis-0 flex-col-reverse overflow-y-auto">
              {shownAsks.map((l, i) => row(l, "SELL", askCum[i]!))}
            </div>
            <div className="z-[1] my-0.5 grid shrink-0 grid-cols-[1fr_1fr_1fr_1fr] items-center border-y border-line bg-raised px-3 py-1 text-[11px]">
              {/* The mid sits in the price column, lined up with the levels above and below it. */}
              <span className="text-faint">Mid</span>
              <span className="num text-right font-medium text-ink" title="Halfway between the best bid and the best ask">
                {mid !== undefined ? fmtPrice(Number(mid.toFixed(pxDecimals + 1))) : "—"}
              </span>
              <span className="col-span-2 text-right text-muted" title="Best ask minus best bid, and that as basis points of the mid">
                spread <span className="num text-ink">{spread !== undefined ? fmtPrice(spread, pxDecimals) : "—"}</span>
                {spread !== undefined && mid ? <span className="num"> · {((spread / mid) * 10_000).toFixed(1)} bps</span> : null}
              </span>
            </div>
            <div className="min-h-0 flex-1 basis-0 overflow-y-auto">{shownBids.map((l, i) => row(l, "BUY", bidCum[i]!))}</div>
          </div>
          <footer className="flex shrink-0 items-center gap-3 border-t border-line px-3 py-1.5 text-[11px] text-muted">
            <span className="inline-flex items-center gap-1.5" title="Your own open orders in this book, by side: quantity, and value at their limit prices">
              <span className="inline-block size-2 rounded-sm bg-accent/70" />
              Yours: bids <span className="num text-buy">{fmtQty(myBids.qty)}</span>
              <span className="num text-muted">({usd(myBids.notional)})</span>· asks <span className="num text-sell">{fmtQty(myAsks.qty)}</span>
              <span className="num text-muted">({usd(myAsks.notional)})</span>
            </span>
            {deeper > 0 && (
              <span className="ml-auto text-accent" title="Your orders priced beyond the levels shown; show more levels to see them">
                +{deeper} deeper
              </span>
            )}
          </footer>
        </div>
      )}
      {confirm && (
        <ConfirmCancel
          title={`Cancel ${confirm.length} order${confirm.length === 1 ? "" : "s"} at ${fmtPrice(confirm[0]?.price)}?`}
          body={`Sends a cancel for your ${confirm[0]?.side ?? ""} ${symbol} order${confirm.length === 1 ? "" : "s"} resting at this price.`}
          pending={cancelMany.isPending}
          onClose={() => setConfirm(undefined)}
          onConfirm={() => cancelMany.mutate(confirm.map((o) => o.orderId), { onSettled: () => setConfirm(undefined) })}
        />
      )}
    </Panel>
  );
}
