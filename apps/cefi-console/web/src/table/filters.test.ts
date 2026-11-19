import { createLiveQueryCollection } from "@tanstack/react-db";
import { describe, expect, it } from "vitest";
import type { OrderRow } from "../../../shared/api.ts";
import { orders, ordersCollection, toOrderRecord } from "../db.ts";
import { dbWhere, describe as describeFilter, filterFnFor, isActive, type ActiveFilter } from "./filters.ts";

const now = 1_795_000_000_000;
const row = (id: string, symbol: string, price: string, qty: string, executed: string, externalId: string, updatedMs: number): OrderRow => ({
  orderId: id,
  externalId,
  symbol,
  side: "BUY",
  type: "LIMIT",
  tif: "GTC",
  status: "ACTIVE",
  price,
  qty,
  leavesQty: String(Number(qty) - Number(executed)),
  executedQty: executed,
  createdNs: `${updatedMs}000000`,
  updatedNs: `${updatedMs}000000`,
});

async function query(filters: ActiveFilter[]) {
  const live = createLiveQueryCollection({
    query: (q) => {
      const base = q.from({ o: ordersCollection });
      return filters.length ? base.where(({ o }) => dbWhere(o as never, filters, now)) : base;
    },
    startSync: true,
  });
  await live.toArrayWhenReady();
  return live.toArray.map((o) => o.orderId).sort();
}

describe("filters in a DB live query", () => {
  orders.mirror.replaceAll(
    [
      row("A1", "TSLA-USDC", "205", "1", "0", "strat-alpha", now - 30_000),
      row("A2", "TSLA-USDC", "210", "1", "0.5", "strat-beta", now - 10 * 60_000),
      row("A3", "NVDA-USDC", "150", "2", "2", "manual_1", now - 5_000),
    ].map(toOrderRecord),
  );

  it("bands a range with exclusive and inclusive bounds", async () => {
    const band = (minOp: ">" | ">=", maxOp: "<" | "<=") => [{ id: "price", meta: { kind: "range" as const, field: "priceN" }, value: { min: 205, minOp, max: 210, maxOp } }];
    expect(await query(band(">", "<"))).toEqual([]);
    expect(await query(band(">=", "<"))).toEqual(["A1"]);
    expect(await query(band(">=", "<="))).toEqual(["A1", "A2"]);
  });

  it("scales a percent filter, multi-selects, searches and windows by time", async () => {
    // Filled more than 40%: stored as 0–1, entered as a percent.
    expect(await query([{ id: "filled", meta: { kind: "range", field: "filledPct", scale: 100 }, value: { min: 40, minOp: ">" } }])).toEqual(["A2", "A3"]);
    expect(await query([{ id: "symbol", meta: { kind: "multi" }, value: ["NVDA-USDC", "MUC-USDC"] }])).toEqual(["A3"]);
    expect(await query([{ id: "externalId", meta: { kind: "text" }, value: "STRAT" }])).toEqual(["A1", "A2"]);
    // _ is a single-character wildcard in LIKE.
    expect(await query([{ id: "externalId", meta: { kind: "text" }, value: "manual_" }])).toEqual(["A3"]);
    expect(await query([{ id: "updated", meta: { kind: "since", field: "updatedMs" }, value: { minutes: 1 } }])).toEqual(["A1", "A3"]);
    // Several filters combine with AND.
    expect(
      await query([
        { id: "symbol", meta: { kind: "multi" }, value: ["TSLA-USDC"] },
        { id: "updated", meta: { kind: "since", field: "updatedMs" }, value: { minutes: 1 } },
      ]),
    ).toEqual(["A1"]);
  });
});

describe("filters in TanStack Table", () => {
  const rowOf = (v: unknown) => ({ getValue: () => v }) as never;
  it("matches the same rules", () => {
    const range = filterFnFor({ kind: "range", scale: 100 });
    expect(range(rowOf(0.5), "x", { min: 40, minOp: ">", maxOp: "<" }, () => {})).toBe(true);
    expect(range(rowOf(null), "x", { min: 40, minOp: ">", maxOp: "<" }, () => {})).toBe(false);
    expect(filterFnFor({ kind: "multi" })(rowOf("USDC"), "x", ["USDC", "SOL"], () => {})).toBe(true);
    expect(filterFnFor({ kind: "text" })(rowOf("SPCXC"), "x", "pcx", () => {})).toBe(true);
  });

  it("knows when a filter is set and says what it does", () => {
    expect(isActive("range", { minOp: ">", maxOp: "<" })).toBe(false);
    expect(isActive("multi", [])).toBe(false);
    expect(describeFilter("Price", { kind: "range", unit: "$" }, { min: 200, minOp: ">", max: 210, maxOp: "<=" })).toBe("Price > $200 and ≤ $210");
    expect(describeFilter("Symbol", { kind: "multi" }, ["A", "B", "C", "D"])).toBe("Symbol: A, B +2");
  });
});
