import { and, createLiveQueryCollection, gt, ilike, inArray, lt } from "@tanstack/react-db";
import { describe, expect, it } from "vitest";
import type { OrderRow } from "../../shared/api.ts";
import { orders, ordersCollection, toOrderRecord } from "./db.ts";

const row = (id: string, symbol: string, price: string, status: OrderRow["status"] = "ACTIVE", updated = "1795000000000000000"): OrderRow => ({
  orderId: id,
  symbol,
  side: "BUY",
  type: "LIMIT",
  tif: "GTC",
  status,
  price,
  qty: "1",
  leavesQty: "1",
  executedQty: "0",
  createdNs: updated,
  updatedNs: updated,
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("orders collection", () => {
  it("answers a live query with ranges, multi-select and partial search, and follows updates", async () => {
    orders.mirror.upsert([row("8001", "TSLA-USDC", "382.1"), row("8002", "NVDA-USDC", "152.3"), row("9003", "TSLA-USDC", "1000")].map(toOrderRecord));

    // Price in a band, one of two symbols, order id containing "00": numbers compare as numbers.
    const live = createLiveQueryCollection({
      query: (q) =>
        q
          .from({ o: ordersCollection })
          .where(({ o }) => and(gt(o.priceN, 200), lt(o.priceN, 999), inArray(o.symbol, ["TSLA-USDC", "MUC-USDC"]), ilike(o.orderId, "%00%"))),
      startSync: true,
    });
    await live.toArrayWhenReady();
    expect(live.toArray.map((o) => o.orderId)).toEqual(["8001"]);

    // A streamed update moves an order into the result, and another out of it.
    orders.mirror.upsert([toOrderRecord(row("8002", "TSLA-USDC", "300")), toOrderRecord(row("8001", "TSLA-USDC", "150"))]);
    await settle();
    expect(live.toArray.map((o) => o.orderId).sort()).toEqual(["8002"]);

    // replaceAll removes rows that are no longer there.
    orders.mirror.replaceAll([toOrderRecord(row("8001", "TSLA-USDC", "250"))]);
    await settle();
    expect(ordersCollection.toArray.map((o) => o.orderId)).toEqual(["8001"]);
    expect(live.toArray.map((o) => o.orderId)).toEqual(["8001"]);
  });

  it("derives the numbers the filters use", () => {
    const r = toOrderRecord({ ...row("1", "X", "200"), qty: "2", executedQty: "0.5", leavesQty: "1.5" });
    expect(r).toMatchObject({ priceN: 200, qtyN: 2, executedN: 0.5, filledPct: 0.25, notionalN: 400, open: true, partial: true });
    expect(toOrderRecord({ ...row("2", "X", ""), price: undefined, type: "MARKET" }).priceN).toBeNull();
  });
});
