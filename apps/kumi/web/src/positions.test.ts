import { describe, expect, it } from "vitest";
import { allocation, allocationAfter, isEmpty, positions } from "./positions.ts";
import type { AssetRow, Holding } from "./types.ts";

const ASSETS: AssetRow[] = [
  { symbol: "SOL", name: "Solana", decimals: 9, icon: "sol.png", cash: false, price: "100" },
  { symbol: "JUP", name: "Jupiter", decimals: 6, icon: null, cash: false, price: "0.5" },
  { symbol: "BONK", name: "Bonk", decimals: 5, icon: null, cash: false, price: null },
  { symbol: "USDC", name: "USD Coin", decimals: 6, icon: "usdc.png", cash: true, price: "1" },
];

function holding(overrides: Partial<Holding> = {}): Holding {
  return { address: "addr", sol: "0", usdc: "0", tokens: {}, value_usd: null, ...overrides };
}

describe("positions", () => {
  it("always lists USDC and SOL, and a token only once it is held", () => {
    const rows = positions(holding({ usdc: "50", sol: "1", tokens: { JUP: "100" } }), null, ASSETS);

    expect(rows.map((r) => r.symbol)).toEqual(["USDC", "SOL", "JUP"]);
    expect(rows.map((r) => r.value)).toEqual([50, 100, 50]);
  });

  it("includes a token held only in the trading wallet, shown as in transit", () => {
    const rows = positions(holding(), holding({ tokens: { JUP: "10" } }), ASSETS);

    expect(rows.find((r) => r.symbol === "JUP")).toMatchObject({
      safekeeping: "0",
      trading: "10",
      quantity: "10",
      inTransit: "10",
      value: 5,
    });
  });

  it("adds both wallets into one quantity and carries each asset's logo", () => {
    const rows = positions(holding({ sol: "1.5" }), holding({ sol: "0.25" }), ASSETS);

    expect(rows.find((r) => r.symbol === "SOL")).toMatchObject({ quantity: "1.75", inTransit: "0.25", icon: "sol.png", value: 175 });
    expect(rows.find((r) => r.symbol === "USDC")).toMatchObject({ icon: "usdc.png", inTransit: null });
  });

  it("leaves a token's value empty while it has no price", () => {
    const rows = positions(holding({ tokens: { BONK: "5000" } }), null, ASSETS);

    expect(rows.find((r) => r.symbol === "BONK")?.value).toBeNull();
  });
});

describe("allocation", () => {
  it("splits by value across every held asset", () => {
    const rows = positions(holding({ usdc: "50", sol: "1", tokens: { JUP: "100" } }), null, ASSETS);

    expect(allocation(rows)).toEqual([
      { symbol: "USDC", pct: 25 },
      { symbol: "SOL", pct: 50 },
      { symbol: "JUP", pct: 25 },
    ]);
  });

  it("is empty while a held asset is unpriced, and when nothing is held", () => {
    expect(allocation(positions(holding({ tokens: { BONK: "5000" } }), null, ASSETS))).toEqual([]);
    expect(allocation(positions(holding(), null, ASSETS))).toEqual([]);
  });
});

describe("isEmpty", () => {
  it("is true only when no asset is held", () => {
    expect(isEmpty(holding())).toBe(true);
    expect(isEmpty(holding({ tokens: { JUP: "1" } }))).toBe(false);
    expect(isEmpty(holding({ sol: "0.01" }))).toBe(false);
  });
});

describe("allocationAfter", () => {
  const rows = positions(holding({ usdc: "50", sol: "0.5" }), null, ASSETS);

  it("moves cash into the asset on a buy", () => {
    expect(allocationAfter(rows, "buy", "SOL", 25)).toEqual([
      { symbol: "SOL", before: 50, after: 75 },
      { symbol: "USDC", before: 50, after: 25 },
    ]);
  });

  it("moves the asset into cash on a sell", () => {
    expect(allocationAfter(rows, "sell", "SOL", 25)).toEqual([
      { symbol: "SOL", before: 50, after: 25 },
      { symbol: "USDC", before: 50, after: 75 },
    ]);
  });

  it("starts an asset the client does not hold at zero", () => {
    expect(allocationAfter(rows, "buy", "JUP", 20)).toEqual([
      { symbol: "JUP", before: 0, after: 20 },
      { symbol: "USDC", before: 50, after: 30 },
    ]);
  });

  it("never goes below zero", () => {
    expect(allocationAfter(rows, "buy", "SOL", 80)?.find((c) => c.symbol === "USDC")?.after).toBe(0);
  });

  it("has nothing to show while a held asset is unpriced, or when nothing is held or traded", () => {
    expect(allocationAfter(positions(holding({ tokens: { BONK: "5000" } }), null, ASSETS), "buy", "SOL", 10)).toBeNull();
    expect(allocationAfter(positions(holding(), null, ASSETS), "buy", "SOL", 10)).toBeNull();
    expect(allocationAfter(rows, "buy", "SOL", 0)).toBeNull();
  });
});
