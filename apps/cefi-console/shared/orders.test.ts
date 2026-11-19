import { describe, expect, it } from "vitest";
import { compareNs, fromDropcopy, fromRest, mergeOrder } from "./orders.ts";

const dropcopy = {
  order_id: "1",
  symbol: "TSLA-USDC",
  side: "BUY" as const,
  order_type: "LIMIT" as const,
  time_in_force: "GTC" as const,
  status: "ACTIVE" as const,
  price: "380",
  quantity: "1",
  leaves_qty: "1",
  executed_qty: "0",
  executed_vwap: "0",
  event_type: "NEW" as const,
  timestamp: "1795039483539000000",
};

describe("orders", () => {
  it("maps a REST order, preferring modify_info for the current terms", () => {
    const row = fromRest(
      {
        id: "9",
        status: "ACTIVE",
        order_info: { instrument_id: "77", qty: "1", price: "100", side: "SELL", type: "LIMIT", tif: "GTC" },
        modify_info: { new_qty: "2", new_price: "101" },
        leaves_qty: "2",
        executed_qty: "0",
        executed_vwap: "0",
        timestamp: "1795039483000000000",
        update_timestamp: "1795039484000000000",
      },
      (id) => (id === "77" ? "NVDA-USDC" : undefined),
    );
    expect(row).toMatchObject({ orderId: "9", symbol: "NVDA-USDC", qty: "2", price: "101", vwap: undefined, updatedNs: "1795039484000000000" });
  });

  it("never lets an older view overwrite a newer one, and keeps the earliest created time", () => {
    const newer = fromDropcopy({ ...dropcopy, status: "FILLED", executed_qty: "1", leaves_qty: "0", timestamp: "1795039490000000000" });
    const older = fromDropcopy({ ...dropcopy, timestamp: "1795039483539000000" });
    const merged = mergeOrder(newer, older);
    expect(merged.status).toBe("FILLED");
    expect(merged.createdNs).toBe("1795039483539000000");
    expect(mergeOrder(older, newer).status).toBe("FILLED");
  });

  it("compares nanosecond strings numerically", () => {
    expect(compareNs("999", "1000")).toBeLessThan(0);
    expect(compareNs("1795039490000000001", "1795039490000000000")).toBeGreaterThan(0);
  });
});
