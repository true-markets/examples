import { describe, expect, it } from "vitest";
import { compareDecimal, floorDecimal, fromUnits, minusDecimal, toUnits } from "./amount.ts";

describe("toUnits and fromUnits", () => {
  it.each([
    ["10", 6, 10_000_000n],
    ["73.4", 6, 73_400_000n],
    ["0.000001", 6, 1n],
    ["0.55", 9, 550_000_000n],
    ["1.000000001", 9, 1_000_000_001n],
    ["0", 9, 0n],
  ])("round-trips %s at %i decimals", (decimal, decimals, units) => {
    expect(toUnits(decimal, decimals)).toBe(units);
    expect(fromUnits(units, decimals)).toBe(decimal);
  });

  it("trims trailing zeros", () => {
    expect(fromUnits(1_500_000n, 6)).toBe("1.5");
    expect(toUnits("1.50", 6)).toBe(1_500_000n);
  });

  it("writes the smallest unit in full", () => {
    expect(fromUnits(1n, 9)).toBe("0.000000001");
  });

  it("throws on more fractional digits than the asset has", () => {
    expect(() => toUnits("0.0000001", 6)).toThrow("more than 6 decimal places");
  });

  it("throws on text that is not a decimal", () => {
    expect(() => toUnits("1e3", 6)).toThrow("not a decimal number");
  });
});

describe("floorDecimal", () => {
  it.each([
    ["0.119197114", 4, "0.1191"],
    ["12.996", 2, "12.99"],
    ["1.5", 4, "1.5"],
    ["7", 2, "7"],
  ])("floors %s to %i places as %s", (value, places, expected) => {
    expect(floorDecimal(value, places)).toBe(expected);
  });
});

describe("compareDecimal", () => {
  it.each([
    ["10", "9.99", 1],
    ["9.99", "10", -1],
    ["1.50", "1.5", 0],
    ["0.000000001", "0", 1],
  ] as const)("compares %s with %s", (a, b, expected) => {
    expect(compareDecimal(a, b)).toBe(expected);
  });
});

describe("minusDecimal", () => {
  it("subtracts at the asset's precision", () => {
    expect(minusDecimal("0.25", "0.01", 9)).toBe("0.24");
  });

  it("goes below zero", () => {
    expect(minusDecimal("0.005", "0.01", 9)).toBe("-0.005");
  });
});
