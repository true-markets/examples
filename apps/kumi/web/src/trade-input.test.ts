import { describe, expect, it } from "vitest";
import { sellableAmount } from "../../shared/trade-rules.ts";
import { buyChips, chipBelowMinimum, estimate, sellChips, validate } from "./trade-input.ts";

const SOL = { symbol: "SOL", decimals: 9 };
const JUP = { symbol: "JUP", decimals: 6 };
const SAFEKEEPING = { usdc: "73.40", asset: "0.25" };
const PRICE = "182.40";

describe("buyChips", () => {
  it("offers 25%, 50%, 75% and Max of the cash available, rounded down to the cent", () => {
    expect(buyChips("73.409")).toEqual([
      { label: "25%", amount: "18.35" },
      { label: "50%", amount: "36.7" },
      { label: "75%", amount: "55.05" },
      { label: "Max", amount: "73.4" },
    ]);
  });

  it("keeps every chip even when it is under the minimum, so the row never changes shape", () => {
    expect(buyChips("6.69")).toEqual([
      { label: "25%", amount: "1.67" },
      { label: "50%", amount: "3.34" },
      { label: "75%", amount: "5.01" },
      { label: "Max", amount: "6.69" },
    ]);
  });

  it("offers nothing when there is no cash", () => {
    expect(buyChips("0")).toEqual([]);
  });
});

describe("chipBelowMinimum", () => {
  it.each([
    ["buy", "5.01", true],
    ["buy", "5.50", false],
    ["buy", "6.69", false],
    ["sell", "0.06", true],
    ["sell", "0.07", false],
  ] as const)("a %s chip of %s is below the minimum: %s", (side, amount, expected) => {
    expect(chipBelowMinimum(side, amount, "84.65", SOL)).toBe(expected);
  });

  it("treats a sell as below the minimum while the price is unknown", () => {
    expect(chipBelowMinimum("sell", "10", null, SOL)).toBe(true);
  });
});

describe("sellChips", () => {
  it("splits the SOL above the 0.01 reserve and rounds the partial chips down to 2 decimals", () => {
    expect(sellChips(SOL, "0.25")).toEqual([
      { label: "25%", amount: "0.06" },
      { label: "50%", amount: "0.12" },
      { label: "75%", amount: "0.18" },
      { label: "Max", amount: "0.24" },
    ]);
  });

  it("makes Max the exact sellable amount, so it stays above the $5.50 minimum", () => {
    const all = sellChips(SOL, "0.129197114").at(-1);

    expect(all).toEqual({ label: "Max", amount: "0.119197114" });
  });

  it("offers nothing when only the reserve is there", () => {
    expect(sellChips(SOL, "0.01")).toEqual([]);
  });

  it("never goes below zero for the sellable amount", () => {
    expect(sellableAmount("SOL", "0.005")).toBe("0");
  });

  it("holds nothing back for a token other than SOL", () => {
    expect(sellChips(JUP, "100")).toEqual([
      { label: "25%", amount: "25" },
      { label: "50%", amount: "50" },
      { label: "75%", amount: "75" },
      { label: "Max", amount: "100" },
    ]);
  });

  it("rounds a token's partial chips down to 2 decimals, keeping Max exact", () => {
    expect(sellChips(JUP, "10.123456")).toEqual([
      { label: "25%", amount: "2.53" },
      { label: "50%", amount: "5.06" },
      { label: "75%", amount: "7.59" },
      { label: "Max", amount: "10.123456" },
    ]);
  });
});

describe("estimate", () => {
  it("divides dollars by the price for a buy", () => {
    expect(estimate("buy", "10", PRICE, "SOL")).toBe("About 0.0548 SOL");
  });

  it("multiplies SOL by the price for a sell", () => {
    expect(estimate("sell", "0.1", PRICE, "SOL")).toBe("About 18.24 USDC");
  });

  it("names the token being bought", () => {
    expect(estimate("buy", "10", "0.5", "JUP")).toBe("About 20 JUP");
  });

  it("gives nothing without a price or an amount", () => {
    expect(estimate("buy", "10", null, "SOL")).toBeNull();
    expect(estimate("buy", "", PRICE, "SOL")).toBeNull();
  });
});

describe("validate", () => {
  it.each([
    ["buy", "", "Enter an amount."],
    ["buy", "0", "Enter an amount."],
    ["buy", "5.49", "Trades start at $5.50."],
    ["buy", "10.005", "Use at most 2 decimal places."],
    ["buy", "73.41", "Only 73.40 USDC in the client wallet."],
    ["buy", "73.40", null],
    ["sell", "0.03", "Trades start at $5.50."],
    ["sell", "0.2401", "Only 0.24 SOL in the client wallet."],
    ["sell", "0.24", null],
  ] as const)("%s %s gives %s", (side, amount, message) => {
    expect(validate(side, amount, SAFEKEEPING, PRICE, SOL)).toBe(message);
  });

  it("refuses a sell while the price is unknown", () => {
    expect(validate("sell", "0.2", SAFEKEEPING, null, SOL)).toBe("The SOL price is not available yet. Try again in a moment.");
  });

  it.each([
    ["100", null],
    ["11", null],
    ["10.9", "Trades start at $5.50."],
    ["100.5", "Only 100 JUP in the client wallet."],
    ["1.1234567", "Use at most 6 decimal places."],
  ])("a sell of %s JUP at $0.50 gives %s", (amount, message) => {
    expect(validate("sell", amount, { usdc: "0", asset: "100" }, "0.50", JUP)).toBe(message);
  });
});
