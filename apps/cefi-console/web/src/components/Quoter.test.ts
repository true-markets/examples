import { describe, expect, it } from "vitest";
import { budgetTone, convertSize, describeReference, validate } from "./Quoter.tsx";

describe("quoter parameter form", () => {
  const levels = { key: "levels", label: "Levels", type: "integer" as const, help: "", min: 1, max: 10 };
  const size = { key: "quoteSize", label: "Quote size", type: "decimal" as const, help: "", min: 0 };
  it("catches typos before sending", () => {
    expect(validate(levels, "3")).toBeUndefined();
    expect(validate(levels, "2.5")).toBe("enter a whole number");
    expect(validate(levels, "11")).toBe("at most 10");
    expect(validate(levels, "abc")).toBe("enter a number");
    expect(validate(size, "0.0001")).toBeUndefined();
    expect(validate(size, "-1")).toBe("at least 0");
  });
});

describe("reference names", () => {
  it("says where the price comes from", () => {
    expect(describeReference("BTC-USD")).toBe("Coinbase BTC-USD");
    expect(describeReference("hyperliquid:xyz:GOOGL")).toBe("Hyperliquid xyz:GOOGL");
  });
});

describe("switching size units", () => {
  it("converts at the reference price", () => {
    expect(convertSize("0.008", 272.5, "quote")).toBe("2.18");
    expect(convertSize("2.18", 272.5, "base")).toBe("0.008");
    expect(convertSize("50", 50000, "base")).toBe("0.001");
    expect(convertSize("0", 50000, "base")).toBe("0");
    expect(convertSize("abc", 50000, "base")).toBe("abc"); // left for the validator to flag
  });
  it("checks a choice against its options", () => {
    const unit = { key: "sizeUnit", label: "Sizes in", type: "choice" as const, help: "", options: ["base", "quote"] };
    expect(validate(unit, "quote")).toBeUndefined();
    expect(validate(unit, "usd")).toBe("one of base, quote");
  });
});

describe("on/off settings", () => {
  it("accept only on or off", () => {
    const spec = { key: "profitTaker", label: "Profit taker", type: "boolean" as const, help: "" };
    expect(validate(spec, "true")).toBeUndefined();
    expect(validate(spec, "false")).toBeUndefined();
    expect(validate(spec, "yes")).toBe("on or off");
  });
});

describe("budget use", () => {
  it("is green below 75%, yellow from 75% to 90%, red above 90%", () => {
    expect([0, 74.9, 75, 90, 90.1, 100].map(budgetTone)).toEqual(["ok", "ok", "warn", "warn", "high", "high"]);
  });
});
