// Where your orders rest in one book, for its market tile: the best bid and ask either side of the
// spread, then a track with a green half for bids and a red half for asks. Your orders are yellow
// markers placed by how far behind the touch they are, in bps, on the same scale in every tile so
// books compare at a glance. An order at the best price gets an outline; one further out than the
// scale is pinned to the end.

import type { OrderRow } from "../../../shared/api.ts";
import { isOpen } from "../../../shared/orders.ts";
import { price, qty } from "../format.ts";
import { cx } from "./ui.tsx";

// How far behind the touch each half of the track reaches.
export const TRACK_BPS = 70;

export interface Marker {
  orderId: string;
  side: "BUY" | "SELL";
  // Left edge to right edge, 0–100.
  pos: number;
  // bps behind the best price on its side (0 at the touch).
  behindBps: number;
  atTouch: boolean;
  // Further out than the track reaches.
  clipped: boolean;
  title: string;
}

export interface TrackLayout {
  // Where the bid and ask touch marks sit, 0–100.
  bidAt: number;
  askAt: number;
  spread: number;
  spreadBps: number;
  markers: Marker[];
}

// The gap between the touch marks grows with the spread, within limits, so a wide book visibly
// opens up in the middle without squeezing either side away.
const GAP_PER_BPS = 0.3;
const MIN_GAP = 4;
const MAX_GAP = 22;

export function layoutTrack(bid: number, ask: number, orders: OrderRow[]): TrackLayout | undefined {
  if (!(bid > 0 && ask > 0 && ask >= bid)) return undefined;
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  const spreadBps = (spread / mid) * 10_000;
  const gap = Math.min(MAX_GAP, Math.max(MIN_GAP, spreadBps * GAP_PER_BPS));
  const bidAt = 50 - gap / 2;
  const askAt = 50 + gap / 2;
  const perBps = bidAt / TRACK_BPS;

  const markers: Marker[] = [];
  for (const o of orders) {
    if (!isOpen(o.status) || o.price === undefined) continue;
    const p = Number(o.price);
    if (!(p > 0)) continue;
    const buy = o.side === "BUY";
    // An order through the touch is at the touch: the EBBO just hasn't caught up.
    const behindBps = Math.max(0, ((buy ? bid - p : p - ask) / mid) * 10_000);
    const atTouch = buy ? p >= bid : p <= ask;
    const clipped = behindBps > TRACK_BPS;
    const along = Math.min(behindBps, TRACK_BPS) * perBps;
    markers.push({
      orderId: o.orderId,
      side: o.side,
      pos: buy ? bidAt - along : askAt + along,
      behindBps,
      atTouch,
      clipped,
      title: `${buy ? "Bid" : "Ask"} ${qty(o.leavesQty)} @ ${price(o.price)} · ${atTouch ? "at the touch" : `${behindBps.toFixed(1)} bps behind`}`,
    });
  }
  // The touch draws last, so it's on top where markers overlap.
  markers.sort((a, b) => Number(a.atTouch) - Number(b.atTouch) || b.behindBps - a.behindBps);
  return { bidAt, askAt, spread, spreadBps, markers };
}

export function QuoteTrack({ bid, ask, orders }: { bid?: string; ask?: string; orders: OrderRow[] }) {
  const t = layoutTrack(Number(bid ?? 0), Number(ask ?? 0), orders);
  const decimals = Math.max(decimalsOf(bid), decimalsOf(ask), 2);
  return (
    <div className="mt-0.5">
      {/* Each price sits on its own side of the spread, over its touch mark. */}
      <div className="num grid grid-cols-[1fr_auto_1fr] items-baseline gap-1.5 text-[11px]">
        <span className="truncate text-right text-buy">{price(bid)}</span>
        <span className="text-faint">{t ? `$${t.spread.toFixed(decimals)}` : "—"}</span>
        <span className="truncate text-sell">{price(ask)}</span>
      </div>
      <div className="relative mt-0.5 h-4" aria-hidden>
        {t && (
          <>
            <div className="absolute top-[6px] left-0 h-[3px] rounded-full bg-buy/30" style={{ width: `${t.bidAt}%` }} />
            <div className="absolute top-[6px] right-0 h-[3px] rounded-full bg-sell/30" style={{ left: `${t.askAt}%` }} />
            <div className="absolute top-0 h-4 w-0.5 -translate-x-1/2 bg-buy" style={{ left: `${t.bidAt}%` }} />
            <div className="absolute top-0 h-4 w-0.5 -translate-x-1/2 bg-sell" style={{ left: `${t.askAt}%` }} />
            {t.markers.map((m) => (
              <span
                key={m.orderId}
                title={m.title}
                className={cx(
                  "absolute top-[3px] h-[9px] w-2 -translate-x-1/2 rounded-[2px] border bg-accent",
                  m.atTouch ? "border-ink" : "border-accent/60",
                  m.clipped && (m.side === "BUY" ? "rounded-l-full" : "rounded-r-full"),
                )}
                style={{ left: `clamp(4px, ${m.pos}%, calc(100% - 4px))` }}
              />
            ))}
          </>
        )}
      </div>
      <div className="num text-center text-[10px] text-faint">{t ? `${t.spreadBps.toFixed(1)} bps` : " "}</div>
    </div>
  );
}

function decimalsOf(v?: string): number {
  const i = v?.indexOf(".") ?? -1;
  return v && i >= 0 ? v.length - i - 1 : 0;
}
