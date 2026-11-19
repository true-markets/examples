import { describe, expect, it } from "vitest";
import { OrderBook } from "./book.ts";

const lvl = (price: string, qty: string, order_count = "1") => ({ price, qty, order_count });

describe("OrderBook", () => {
  it("replaces on snapshot and merges updates, dropping qty 0 levels", () => {
    const b = new OrderBook("TSLA-USDC");
    b.apply("SNAPSHOT", { symbol: "TSLA-USDC", bids: [lvl("381.7", "1"), lvl("381.8", "2")], asks: [lvl("382.2", "1")] }, "10");
    expect(b.levels().bids.map((l) => l.price)).toEqual([381.8, 381.7]);

    // Live updates carry only changed levels; "381.80" is the same level as "381.8".
    expect(b.apply("UPDATE", { symbol: "TSLA-USDC", bids: [lvl("381.80", "0", "0"), lvl("381.75", "3", "2")], asks: [] }, "11")).toBe(true);
    const { bids, asks } = b.levels();
    expect(bids.map((l) => [l.price, l.qty, l.orders])).toEqual([
      [381.75, 3, 2],
      [381.7, 1, 1],
    ]);
    expect(asks).toHaveLength(1);

    b.apply("SNAPSHOT", { symbol: "TSLA-USDC", bids: [], asks: [lvl("383", "1")] }, "40");
    expect(b.levels().bids).toHaveLength(0);
  });

  it("reports a skipped sequence number", () => {
    const b = new OrderBook("X");
    b.apply("SNAPSHOT", { symbol: "X", bids: [], asks: [] }, "5");
    expect(b.apply("UPDATE", { symbol: "X", bids: [lvl("1", "1")] }, "6")).toBe(true);
    expect(b.apply("UPDATE", { symbol: "X", bids: [lvl("1", "2")] }, "8")).toBe(false);
  });

  // Seen on the live feed: snapshot 102003, then the first update is also 102003.
  it("accepts a first update that repeats the snapshot's seqnum", () => {
    const b = new OrderBook("X");
    b.apply("SNAPSHOT", { symbol: "X", bids: [lvl("1", "1")], asks: [] }, "102003");
    expect(b.apply("UPDATE", { symbol: "X", asks: [lvl("2", "1")] }, "102003")).toBe(true);
    expect(b.apply("UPDATE", { symbol: "X", asks: [lvl("2", "3")] }, "102004")).toBe(true);
    expect(b.levels().asks[0]?.qty).toBe(3);
  });

  it("reads the spec's depth field when order_count is absent", () => {
    const b = new OrderBook("X");
    b.apply("SNAPSHOT", { symbol: "X", bids: [{ price: "1", qty: "1", depth: "4" }] });
    expect(b.levels().bids[0]?.orders).toBe(4);
  });
});

