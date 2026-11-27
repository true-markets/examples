import type { QuoterBookSummary, QuoterDeskStatus, QuoterOrder, QuoterTakeSide } from "../../shared/api.ts";

// What each book is quoting against the exchange, one row per book: the exchange's best bid and
// ask (EBBO), the book's own best bid and ask and how many quotes it rests each side, the skew on
// its mid, and how close each side is to a take.

export interface TakeGauge {
  kind: QuoterTakeSide["kind"];
  enabled: boolean;
  edgeBps: number | null;
  thresholdBps: number;
  // Edge over what a take needs, 0 to 1: 1 is there. Over 1 is past it.
  closeness: number;
  // bps still short of taking; 0 or less is there.
  shortBps: number | null;
  // It would take now: on, and nothing in the way.
  would: boolean;
  blocker?: string;
}

export interface QuotingRow {
  symbol: string;
  quote: string;
  state: QuoterBookSummary["state"];
  bboBid: number | null;
  bboAsk: number | null;
  bboSpread: number | null;
  bboSpreadBps: number | null;
  myBid: number | null;
  myAsk: number | null;
  // How far the book's best quote is behind the exchange's best on its side, in bps of the mid: 0
  // at the touch.
  bidBehindBps: number | null;
  askBehindBps: number | null;
  quoteSpread: number | null;
  quoteSpreadBps: number | null;
  bids: number;
  asks: number;
  // The resting quotes, for the track.
  quotes: QuoterOrder[];
  // The skewed mid, and the skew as a share of its cap: + shades the mid down (long, leaning to
  // sell), − up (short). null without a cap set.
  mid: number | null;
  skewBps: number;
  skewMaxBps: number;
  skewLean: number | null;
  // SELL hits the best bid; BUY lifts the best ask.
  take: { sell: TakeGauge; buy: TakeGauge } | null;
  // An older quoter sends none of this.
  known: boolean;
}

const num = (v: string | null | undefined) => {
  const n = v == null ? NaN : Number(v);
  return n > 0 ? n : null;
};

export function gauge(t: QuoterTakeSide): TakeGauge {
  const edge = t.edgeBps;
  let closeness = 0;
  if (edge !== null) closeness = t.thresholdBps > 0 ? Math.max(0, edge / t.thresholdBps) : edge > 0 ? 1 : 0;
  return {
    kind: t.kind,
    enabled: t.enabled,
    edgeBps: edge,
    thresholdBps: t.thresholdBps,
    closeness,
    shortBps: edge === null ? null : t.thresholdBps - edge,
    would: t.enabled && !t.blocker,
    blocker: t.blocker,
  };
}

export function quotingRow(b: QuoterBookSummary): QuotingRow {
  const bboBid = num(b.bestBid);
  const bboAsk = num(b.bestAsk);
  const quotes = (b.quotes ?? []).filter((o) => num(o.price) !== null);
  const bidQuotes = quotes.filter((o) => o.side === "BUY");
  const askQuotes = quotes.filter((o) => o.side === "SELL");
  const myBid = bidQuotes.length ? Math.max(...bidQuotes.map((o) => Number(o.price))) : null;
  const myAsk = askQuotes.length ? Math.min(...askQuotes.map((o) => Number(o.price))) : null;
  const bboMid = bboBid !== null && bboAsk !== null ? (bboBid + bboAsk) / 2 : null;
  // Spreads and distances in bps of the EBBO mid, or the book's own mid without one.
  const mid = num(b.mid);
  const base = bboMid ?? mid ?? num(b.reference);
  const bps = (v: number) => (base ? (v / base) * 10_000 : null);
  const bboSpread = bboBid !== null && bboAsk !== null ? bboAsk - bboBid : null;
  const quoteSpread = myBid !== null && myAsk !== null ? myAsk - myBid : null;
  const skewMaxBps = b.skewMaxBps ?? 0;
  const skewBps = b.skewBps ?? 0;
  return {
    symbol: b.market.symbol,
    quote: b.market.quoteSymbol,
    state: b.state,
    bboBid,
    bboAsk,
    bboSpread,
    bboSpreadBps: bboSpread === null ? null : bps(bboSpread),
    myBid,
    myAsk,
    bidBehindBps: myBid !== null && bboBid !== null ? bps(Math.max(0, bboBid - myBid)) : null,
    askBehindBps: myAsk !== null && bboAsk !== null ? bps(Math.max(0, myAsk - bboAsk)) : null,
    quoteSpread,
    quoteSpreadBps: quoteSpread === null ? null : bps(quoteSpread),
    bids: bidQuotes.length,
    asks: askQuotes.length,
    quotes,
    mid,
    skewBps,
    skewMaxBps,
    skewLean: skewMaxBps > 0 ? Math.max(-1, Math.min(1, skewBps / skewMaxBps)) : null,
    take: b.taking ? { sell: gauge(b.taking.sell), buy: gauge(b.taking.buy) } : null,
    known: b.quotes !== undefined,
  };
}

// Quoting books first, then waiting, then stopped; by symbol within each.
export function quotingRows(d: QuoterDeskStatus): QuotingRow[] {
  const order = { quoting: 0, waiting: 1, stopped: 2 };
  return d.books.map(quotingRow).sort((a, b) => order[a.state] - order[b.state] || a.symbol.localeCompare(b.symbol));
}
