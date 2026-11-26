import type { QuoterDeskStatus } from "../../shared/api.ts";

// What makes up the quoter's open PnL. Each book counts only its own position (its fills since it
// started or was last reset), marked to its reference mid: (mid − avg cost) × position. Everything
// else adds nothing to open, and the breakdown says why.

export interface CountedBook {
  symbol: string;
  quote: string;
  position: number;
  avgCost: number | null; // null from a quoter too old to send it
  mark: number;
  // How far the mark is from the average cost, in bps of the cost: + when the mark is above it.
  moveBps: number | null;
  open: number;
  since: string | null;
}

export type NotCounted =
  // Back to zero: its gains and losses are all realized.
  | { kind: "flat"; symbol: string; realized: number; quote: string }
  // A position, but no reference price to mark it to.
  | { kind: "no-reference"; symbol: string; position: number; base: string }
  // Held in the account but not by any book: there before the books started, or traded by hand.
  | { kind: "outside"; asset: string; account: number; inBooks: number; outside: number; valueUsd: number | null };

export interface OpenPnl {
  counted: CountedBook[];
  notCounted: NotCounted[];
  // The open PnL per quote currency, as the quoter adds it up.
  totals: { quote: string; open: number }[];
}

// Smaller than this is rounding, not a holding.
const DUST = 1e-9;

export function openPnl(d: QuoterDeskStatus): OpenPnl {
  const counted: CountedBook[] = [];
  const notCounted: NotCounted[] = [];
  for (const b of d.books) {
    const position = Number(b.position);
    const symbol = b.market.symbol;
    if (Math.abs(position) < DUST) {
      notCounted.push({ kind: "flat", symbol, realized: Number(b.realizedPnl), quote: b.market.quoteSymbol });
      continue;
    }
    if (b.reference === null) {
      notCounted.push({ kind: "no-reference", symbol, position, base: b.market.baseSymbol });
      continue;
    }
    const mark = Number(b.reference);
    const avgCost = b.avgCost === undefined ? null : Number(b.avgCost);
    counted.push({
      symbol,
      quote: b.market.quoteSymbol,
      position,
      avgCost,
      mark,
      moveBps: avgCost ? ((mark - avgCost) / avgCost) * 10_000 : null,
      open: Number(b.unrealizedPnl),
      since: b.positionSince ?? null,
    });
  }
  counted.sort((a, b) => Math.abs(b.open) - Math.abs(a.open) || a.symbol.localeCompare(b.symbol));

  // Per base asset: what the account holds against what the books that trade it hold.
  const inBooks = new Map<string, number>();
  for (const b of d.books) inBooks.set(b.market.baseAssetId, (inBooks.get(b.market.baseAssetId) ?? 0) + Number(b.position));
  for (const [assetId, held] of inBooks) {
    const bal = d.balances.find((x) => x.assetId === assetId);
    if (!bal) continue;
    const account = Number(bal.spendable);
    const outside = account - held;
    if (Math.abs(outside) < DUST) continue;
    notCounted.push({ kind: "outside", asset: bal.symbol, account, inBooks: held, outside, valueUsd: bal.price === null ? null : outside * Number(bal.price) });
  }

  return { counted, notCounted, totals: d.totals.map((t) => ({ quote: t.quote, open: Number(t.unrealizedPnl) })) };
}
