import { describe, expect, it } from "vitest";
import { approxUsd, feesLine, feesUsd, lastActivity, quantity, shortAddress, stamp, tokenAmount, tradeTitle, unitPrice, usd, usdShort } from "./format.ts";
import type { HouseholdSummary } from "./types.ts";

describe("usd", () => {
  it.each([
    ["10", "$10.00"],
    [25000, "$25,000.00"],
    ["182.444", "$182.44"],
    [null, "–"],
    ["", "–"],
  ])("formats %s as %s", (value, text) => {
    expect(usd(value)).toBe(text);
  });

  it("drops cents from a round amount in a sentence", () => {
    expect(usdShort("10")).toBe("$10");
    expect(usdShort("10.5")).toBe("$10.50");
  });
});

describe("tokenAmount", () => {
  it.each([
    ["0.0547", "SOL", "0.0547 SOL"],
    ["1", "SOL", "1.00 SOL"],
    ["0.0001", "SOL", "0.0001 SOL"],
    ["9.104", "USDC", "9.10 USDC"],
    ["0.0024", "USDC", "0.0024 USDC"],
  ])("formats %s %s", (value, symbol, text) => {
    expect(tokenAmount(value, symbol)).toBe(text);
  });
});

describe("shortAddress", () => {
  it("keeps the first and last four characters", () => {
    expect(shortAddress("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toBe("7xKX…gAsU");
  });

  it("leaves a short string alone", () => {
    expect(shortAddress("abc")).toBe("abc");
  });
});

describe("tradeTitle", () => {
  it("names a running buy by its dollars and a finished one by what it got", () => {
    expect(tradeTitle({ side: "buy", asset: "SOL", status: "buying", usd: "10" })).toBe("Buy $10 of Solana");
    expect(tradeTitle({ side: "buy", asset: "SOL", status: "complete", usd: "10", received: "0.0547" })).toBe("Bought 0.0547 SOL for $10.00");
  });

  it("names a sell by its SOL", () => {
    expect(tradeTitle({ side: "sell", asset: "SOL", status: "stopped", qty: "0.05" })).toBe("Sell 0.05 SOL");
    expect(tradeTitle({ side: "sell", asset: "SOL", status: "complete", qty: "0.05", received: "9.1" })).toBe("Sold 0.05 SOL for 9.10 USDC");
  });
});

describe("tradeTitle for another token", () => {
  it("names the token by its symbol", () => {
    expect(tradeTitle({ side: "buy", asset: "JUP", status: "buying", usd: "6" })).toBe("Buy $6 of JUP");
    expect(tradeTitle({ side: "buy", asset: "JUP", status: "complete", usd: "6", received: "11.9" })).toBe("Bought 11.90 JUP for $6.00");
    expect(tradeTitle({ side: "sell", asset: "JUP", status: "complete", qty: "12", received: "5.98" })).toBe("Sold 12.00 JUP for 5.98 USDC");
  });
});

describe("unitPrice", () => {
  it.each([
    [84.86, "$84.86"],
    [0.2593, "$0.2593"],
    ["0.26", "$0.26"],
    [0.00001873, "$0.00001873"],
    [null, "–"],
  ])("formats %s as %s", (value, text) => {
    expect(unitPrice(value)).toBe(text);
  });
});

describe("quantity", () => {
  it("reads a zero or missing amount as a dash", () => {
    expect(quantity("0", "SOL")).toBe("–");
    expect(quantity(null, "SOL")).toBe("–");
    expect(quantity("0.0801", "SOL")).toBe("0.0801 SOL");
  });
});

describe("feesUsd", () => {
  it("adds USDC fees as dollars and prices the traded asset's fee at the order's average price", () => {
    const fees = [
      { asset: "USDC", amount: "0.01" },
      { asset: "JUP", amount: "0.7069" },
    ];

    expect(feesUsd(fees, "JUP", "0.26")).toBeCloseTo(0.1938, 4);
  });

  it("gives nothing when a fee is in an asset the price can't value", () => {
    expect(feesUsd([{ asset: "BONK", amount: "5" }], "JUP", "0.26")).toBeNull();
  });
});

describe("approxUsd", () => {
  it.each([
    [0.1938, "≈ $0.19"],
    [0.001, "Under $0.01"],
    [0, "$0.00"],
    [null, "–"],
  ])("shows %s as %s", (value, text) => {
    expect(approxUsd(value)).toBe(text);
  });
});

describe("feesLine", () => {
  it("lists each asset's fee without converting", () => {
    expect(
      feesLine([
        { asset: "USDC", amount: "0.02" },
        { asset: "SOL", amount: "0.0001" },
      ]),
    ).toBe("0.02 USDC + 0.0001 SOL");
  });

  it("says None when nothing was charged", () => {
    expect(feesLine([])).toBe("None");
  });
});

describe("lastActivity", () => {
  const household = {
    ready: true,
    created_at: "2026-03-04T10:00:00Z",
    last_trade: null,
  } as unknown as HouseholdSummary;

  it("reads Added with the month for a household without trades", () => {
    expect(lastActivity(household)).toBe("Added Mar 2026");
  });

  it("reads Setup not finished for a half-created household", () => {
    expect(lastActivity({ ...household, ready: false })).toBe("Setup not finished");
  });

  it("shows the running status, then the finished trade with its date", () => {
    const trade = { id: "t", side: "buy" as const, asset: "SOL", usd: "10", created_at: "2026-11-11T10:00:00Z" };
    expect(lastActivity({ ...household, last_trade: { ...trade, status: "returning" } })).toBe("Returning to the client wallet");
    expect(lastActivity({ ...household, last_trade: { ...trade, status: "complete", received: "0.0547" } })).toBe(
      "Bought 0.0547 SOL for $10.00 · Nov 11",
    );
  });
});

describe("stamp", () => {
  it("says Today for a time earlier today", () => {
    const now = Date.parse("2026-11-11T15:00:00");
    expect(stamp("2026-11-11T10:42:00", now)).toBe("Today, 10:42");
    expect(stamp("2026-11-10T10:42:00", now)).toBe("Nov 10, 10:42");
  });
});
