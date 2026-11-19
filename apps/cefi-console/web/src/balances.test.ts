import { describe, expect, it } from "vitest";
import type { Balances } from "../../shared/api.ts";
import { custodyAmount, toRows } from "./balances.ts";

const wallet = (symbol: string, chain: string, total: string, allocated: string) => ({
  assetId: `${symbol}-${chain}`,
  symbol,
  chain,
  total,
  available: total,
  held: "0",
  allocated,
  stable: symbol === "USDC",
});
const cefi = (symbol: string, balance: string, unsettled = "0") => ({
  assetId: symbol,
  symbol,
  balance,
  unsettled,
  orderHold: "0",
  transferHold: "0",
  tradable: balance,
  state: "OPEN",
});

describe("toRows", () => {
  it("sums chains into one row, adds allocated back into the wallet, and keeps CeFi-only assets", () => {
    const data: Balances = {
      prices: { USDC: { price: 1, valueUsd: 2276.5 }, BTC: { price: 90000, valueUsd: 90 } },
      // Shaped like a real account: GET /balances reports wallet totals net of what is allocated.
      wallet: [wallet("USDC", "solana", "110", "2166"), wallet("USDC", "base", "24", "0")],
      cefi: [cefi("USDC", "2166", "-5"), cefi("BTC", "0.001")],
      feesHold: "0",
      unsettledFees: "0",
      cefiSymbols: ["USDC", "BTC"],
    };
    const rows = toRows(data);
    const usdc = rows.find((r) => r.symbol === "USDC")!;
    expect(usdc.wallet).toBe(2300);
    expect(usdc.allocated).toBe(2166);
    expect(usdc.allocatedPct).toBeCloseTo(2166 / 2300);
    expect(usdc.wallets).toHaveLength(2);
    expect(usdc.valueUsd).toBe(2276.5);
    expect(usdc.cefi?.unsettled).toBe("-5");
    const btc = rows.find((r) => r.symbol === "BTC")!;
    expect(btc).toMatchObject({ wallet: 0, allocatedPct: null, valueUsd: 90 });
  });
});

describe("custodyAmount", () => {
  const base = { price: 145.64, decimals: 8, max: 2.43, symbol: "SPCXC" };
  it("converts USD to a quantity, rounded down to the token's decimals", () => {
    // 100 / 145.64 = 0.686624553…
    expect(custodyAmount({ ...base, unit: "USD", input: "100" })).toMatchObject({ ok: true, qty: "0.68662455", describe: "= 0.68662455 SPCXC" });
  });
  it("shows the USD value of a quantity", () => {
    const r = custodyAmount({ ...base, unit: "QTY", input: "1.5" });
    expect(r).toMatchObject({ ok: true, qty: "1.5" });
    expect((r as { usdValue: number }).usdValue).toBeCloseTo(218.46);
  });
  it("refuses more than is available, finer than the token, or USD without a price", () => {
    expect(custodyAmount({ ...base, unit: "USD", input: "400" }).ok).toBe(false);
    expect(custodyAmount({ ...base, unit: "QTY", input: "0.123456789" }).ok).toBe(false);
    expect(custodyAmount({ ...base, unit: "USD", input: "10", price: null }).ok).toBe(false);
    expect(custodyAmount({ ...base, unit: "QTY", input: ".5" })).toMatchObject({ ok: true, qty: "0.5" });
  });
});
