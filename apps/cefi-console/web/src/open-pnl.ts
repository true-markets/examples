import type { QuoterDeskStatus } from "../../shared/api.ts";

// What makes up the quoter's open PnL, one row per book. A book's open PnL is its own position
// (its fills since it started or was last reset) marked to its reference mid:
// (mid − avg cost) × position. What the account holds beyond that is the book's starting position,
// and adds nothing to open.

export interface OpenPnlRow {
  symbol: string;
  base: string;
  quote: string;
  // Held in the account outside the books that trade this asset: there before they started
  // counting, or traded by hand. Null when the account's balance of it isn't known.
  starting: number | null;
  // Other books trade the same asset, so the starting position is theirs too.
  sharedStart: boolean;
  position: number;
  avgCost: number | null; // null from a quoter too old to send it
  mark: number | null; // null with no reference price yet
  // How far the mark is from the average cost, in bps of the cost: + when the mark is above it.
  moveBps: number | null;
  open: number;
  since: string | null;
  // counted: a position marked to a price. flat: nothing to mark; what it made is realized.
  // no-reference: a position, but no price to mark it to, so it counts as 0.
  status: "counted" | "flat" | "no-reference";
  realized: number; // before fees
  // What the exchange charged for the fills counted in the position; null from an older quoter.
  fees: number | null;
  // Realized plus open, less fees.
  net: number;
  // Exit PnL: what closing the position now would come to against the exchange's book; null when
  // flat or with nothing to price it against.
  exit: {
    price: number;
    value: number;
    pnl: number;
    // Unwind cost: how much worse the exit is than the mid mark on the same quantity, in dollars and
    // bps of the mid (negative is worse). null without a mark.
    unwindUsd: number | null;
    unwindBps: number | null;
    // Only part of the position: the book is too thin to close all of it.
    partialQty: number | null;
    levels: number;
    topOnly: boolean;
  } | null;
  // The inventory against the max position change: lean is position over max (−1 the limit short,
  // +1 long), used its size, left how much further it may go the way it's going.
  inventory: { lean: number; used: number; left: number; leftUsd: number | null; max: number; buyRoom: number; sellRoom: number } | null;
}

export interface OpenPnlTotal {
  quote: string;
  open: number;
  realized: number;
  fees: number | null;
  net: number;
}

export interface OpenPnl {
  rows: OpenPnlRow[];
  // Per quote currency, as the quoter adds it up.
  totals: OpenPnlTotal[];
}

// Unwind cost: closing qty of a position at exitPrice against marking it at the mid, in dollars and
// in bps of the mid; negative when the exit is worse, as it is when it crosses the spread.
export function unwind(position: number, mark: number | null, exitPrice: number, qty: number): { unwindUsd: number | null; unwindBps: number | null } {
  if (mark === null || !(mark > 0) || position === 0) return { unwindUsd: null, unwindBps: null };
  const dir = position > 0 ? 1 : -1; // a long sells, so a lower price is worse; a short buys
  return { unwindUsd: (exitPrice - mark) * qty * dir, unwindBps: ((exitPrice - mark) / mark) * 10_000 * dir };
}

// Smaller than this is rounding, not a holding.
const DUST = 1e-9;

export function openPnl(d: QuoterDeskStatus): OpenPnl {
  // Per base asset: what the books that trade it hold, and how many there are.
  const inBooks = new Map<string, { held: number; books: number }>();
  for (const b of d.books) {
    const x = inBooks.get(b.market.baseAssetId) ?? { held: 0, books: 0 };
    inBooks.set(b.market.baseAssetId, { held: x.held + Number(b.position), books: x.books + 1 });
  }

  const order = { counted: 0, "no-reference": 1, flat: 2 };
  const rows = d.books.map((b): OpenPnlRow => {
    const position = Number(b.position);
    const flat = Math.abs(position) < DUST;
    const mark = b.reference === null ? null : Number(b.reference);
    const avgCost = b.avgCost === undefined || flat ? null : Number(b.avgCost);
    const asset = inBooks.get(b.market.baseAssetId)!;
    const bal = d.balances.find((x) => x.assetId === b.market.baseAssetId);
    let starting = bal ? Number(bal.spendable) - asset.held : null;
    if (starting !== null && Math.abs(starting) < DUST) starting = 0;
    const open = Number(b.unrealizedPnl);
    const realized = Number(b.realizedPnl);
    const fees = b.fees === undefined ? null : Number(b.fees);
    const x = b.exit;
    const exitQty = x ? Number(x.qty) : 0;
    let inventory: OpenPnlRow["inventory"] = null;
    if (b.limit) {
      const max = Number(b.limit.max);
      // Long uses up what it may still buy; short, what it may still sell.
      const left = Number(position >= 0 ? b.limit.buyRoom : b.limit.sellRoom);
      const lean = max > 0 ? position / max : 0;
      inventory = {
        lean,
        used: Math.abs(lean),
        left,
        leftUsd: mark === null ? null : left * mark,
        max,
        buyRoom: Number(b.limit.buyRoom),
        sellRoom: Number(b.limit.sellRoom),
      };
    }
    return {
      symbol: b.market.symbol,
      base: b.market.baseSymbol,
      quote: b.market.quoteSymbol,
      starting,
      sharedStart: asset.books > 1,
      position: flat ? 0 : position,
      avgCost,
      mark,
      moveBps: avgCost && mark !== null ? ((mark - avgCost) / avgCost) * 10_000 : null,
      open,
      since: b.positionSince ?? null,
      status: flat ? "flat" : mark === null ? "no-reference" : "counted",
      realized,
      fees,
      net: realized + open - (fees ?? 0),
      exit:
        x && !flat
          ? {
              price: Number(x.price),
              value: Number(x.value),
              pnl: Number(x.pnl),
              ...unwind(position, mark, Number(x.price), Number(x.qty)),
              partialQty: exitQty < Math.abs(position) - DUST ? exitQty : null,
              levels: x.levels,
              topOnly: x.source === "top",
            }
          : null,
      inventory,
    };
  });
  rows.sort((a, b) => order[a.status] - order[b.status] || Math.abs(b.open) - Math.abs(a.open) || a.symbol.localeCompare(b.symbol));

  const totals = d.totals.map((t): OpenPnlTotal => {
    const open = Number(t.unrealizedPnl);
    const realized = Number(t.realizedPnl);
    const fees = t.fees === undefined ? null : Number(t.fees);
    return { quote: t.quote, open, realized, fees, net: realized + open - (fees ?? 0) };
  });
  return { rows, totals };
}
