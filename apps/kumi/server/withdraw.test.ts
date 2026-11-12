import { describe, expect, it } from "vitest";
import { JUP_MINT, SOL_MINT, testCatalog, USDC_MINT } from "./testing.ts";
import { planTransferAll } from "./withdraw.ts";

describe("planTransferAll", () => {
  it("lists USDC first, then each offered token the wallet holds, and leaves SOL for last", () => {
    const plan = planTransferAll({ sol: "1", tokens: { [JUP_MINT]: "20", [USDC_MINT]: "50", [SOL_MINT]: "9" } }, testCatalog);

    expect(plan.map((p) => [p.asset.symbol, p.amount])).toEqual([
      ["USDC", "50"],
      ["JUP", "20"],
    ]);
  });

  it("skips a zero balance and a token the catalog does not offer", () => {
    const plan = planTransferAll({ sol: "1", tokens: { [USDC_MINT]: "0", "UnknownMint111": "5" } }, testCatalog);

    expect(plan).toEqual([]);
  });
});
