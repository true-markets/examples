import { describe, expect, it } from "vitest";
import { store } from "./store.ts";

describe("tape", () => {
  it("starts a book with its last trade, then stamps live trades on arrival", () => {
    const last = "1795014441147571791";
    const ebbo = { symbol: "MSTRC-USDC", info: { last_trade: { price: "93.5", qty: "0.01", timestamp: last } } };
    store.handle({ seqnum: "1", channel: "EBBO", update: "SNAPSHOT", data: ebbo });
    // A second snapshot (after a reconnect) doesn't add it again.
    store.handle({ seqnum: "2", channel: "EBBO", update: "SNAPSHOT", data: ebbo });
    expect(store.tape.get("MSTRC-USDC")).toMatchObject([{ source: "last", timestampNs: last }]);

    // Shaped like the live feed: the exchange sends timestamp "0".
    const before = Date.now();
    store.handle({
      seqnum: "684",
      channel: "TRADE",
      update: "UPDATE",
      data: { match_id: "4266", taking_side: "BUY", info: { price: "93.598", qty: "0.017", timestamp: "0" }, symbol: "MSTRC-USDC" },
    });
    const [newest] = store.tape.get("MSTRC-USDC")!;
    expect(newest).toMatchObject({ id: "4266", source: "live", price: "93.598" });
    expect(Number(BigInt(newest!.timestampNs) / 1_000_000n)).toBeGreaterThanOrEqual(before);
    expect(store.allTrades()[0]?.id).toBe("4266");
  });
});

describe("fills", () => {
  const live = (order: string, ts: string) => ({ id: `live:${order}:${ts}`, orderId: order, symbol: "SPCXC-USDC", side: "SELL" as const, price: "144.988", qty: "0.01", timestampNs: ts });
  const rest = (match: string, order: string, ts: string) => ({ ...live(order, ts), id: `${match}:${order}`, liquidity: "MAKER" as const, feeBps: "0" });

  it("replaces a streamed fill with its REST version even when the timestamps differ slightly", () => {
    store.seedFills([]);
    // Shaped like the duplicate seen live: the same fill, timestamps a fraction of a millisecond apart.
    store.fills.unshift(live("O1", "1795095084955900000"));
    store.mergeFills([rest("M1", "O1", "1795095084955200000")]);
    expect(store.fills).toHaveLength(1);
    expect(store.fills[0]).toMatchObject({ id: "M1:O1", liquidity: "MAKER" });
  });

  it("pairs identical partial fills one to one, and keeps the ones REST doesn't have yet", () => {
    store.seedFills([]);
    store.fills.unshift(live("O2", "1795095090000000000"), live("O2", "1795095090500000000"));
    store.mergeFills([rest("M2", "O2", "1795095090000100000")]);
    expect(store.fills.map((f) => f.id).sort()).toEqual(["M2:O2", "live:O2:1795095090500000000"].sort());
    // A full reseed keeps REST's record and the still-unmatched streamed fill.
    store.seedFills([rest("M2", "O2", "1795095090000100000"), rest("M3", "O2", "1795095090500300000")]);
    expect(store.fills.map((f) => f.id).sort()).toEqual(["M2:O2", "M3:O2"]);
  });
});
