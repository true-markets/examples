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
