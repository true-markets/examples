import { describe, expect, it } from "vitest";
import type { QuoterBookSummary, QuoterOrder, QuoterTakeSide } from "../../shared/api.ts";
import { gauge, quotingRow } from "./quoting.ts";

const quote = (side: "BUY" | "SELL", level: number, price: string): QuoterOrder => ({
  externalId: `${side}-${level}`,
  side,
  level,
  price,
  qty: "1",
  leaves: "1",
  executed: "0",
  status: "ACTIVE",
});

const take = (side: "BUY" | "SELL", edgeBps: number | null, thresholdBps: number, extra: Partial<QuoterTakeSide> = {}): QuoterTakeSide => ({
  side,
  kind: "takeout",
  enabled: true,
  price: "100",
  qty: "1",
  edgeBps,
  thresholdBps,
  size: "1",
  blocker: "no edge",
  ...extra,
});

const book = (extra: Partial<QuoterBookSummary>) =>
  ({ market: { symbol: "TSLA-USDC", quoteSymbol: "USDC" }, state: "quoting", reference: "100", ...extra }) as QuoterBookSummary;

describe("quotingRow", () => {
  it("lays the book's best quotes against the exchange's, in bps of the EBBO mid", () => {
    const r = quotingRow(
      book({
        bestBid: "99.9",
        bestAsk: "100.1",
        mid: "99.98",
        skewBps: 2,
        skewMaxBps: 8,
        quotes: [quote("BUY", 0, "99.9"), quote("BUY", 1, "99.8"), quote("SELL", 0, "100.15"), quote("SELL", 1, "100.3"), quote("SELL", 2, "100.5")],
      }),
    );
    expect([r.bboBid, r.bboAsk, r.myBid, r.myAsk, r.bids, r.asks]).toEqual([99.9, 100.1, 99.9, 100.15, 2, 3]);
    expect(r.bboSpreadBps).toBeCloseTo(20, 6);
    expect(r.quoteSpreadBps).toBeCloseTo(25, 6);
    expect(r.bidBehindBps).toBe(0);
    expect(r.askBehindBps).toBeCloseTo(5, 6);
    expect(r.skewLean).toBeCloseTo(0.25, 9);
    expect(r.known).toBe(true);
  });

  it("leaves what it can't know blank: no EBBO, no quotes, no skew cap, an older quoter", () => {
    const r = quotingRow(book({}));
    expect([r.bboBid, r.myBid, r.bboSpreadBps, r.quoteSpreadBps, r.skewLean, r.take]).toEqual([null, null, null, null, null, null]);
    expect(r.known).toBe(false);
  });
});

describe("gauge", () => {
  it("measures the edge against what a take needs", () => {
    const g = gauge(take("SELL", 3, 12));
    expect([g.closeness, g.shortBps, g.would]).toEqual([0.25, 9, false]);
  });

  it("is there, and past it, when nothing blocks it", () => {
    const g = gauge(take("BUY", 18, 12, { blocker: undefined }));
    expect(g.closeness).toBeCloseTo(1.5, 9);
    expect(g.would).toBe(true);
  });

  it("counts a negative edge or none as nowhere near", () => {
    expect(gauge(take("BUY", -4, 12)).closeness).toBe(0);
    expect(gauge(take("BUY", null, 12)).shortBps).toBeNull();
  });
});
