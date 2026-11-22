import { describe, expect, it } from "vitest";
import type { QuoterParamSpec } from "../../shared/api.ts";
import { applyOp, opAllowed } from "./bulk-params.ts";

const spread: QuoterParamSpec = { key: "spreadBps", label: "Spread", type: "number", unit: "bps", help: "" };
const levels: QuoterParamSpec = { key: "levels", label: "Levels", type: "integer", help: "", min: 1, max: 10 };
const size: QuoterParamSpec = { key: "quoteSize", label: "Quote size", type: "decimal", unit: "size", help: "" };

describe("all-books parameter arithmetic", () => {
  it("sets, adds and scales", () => {
    expect(applyOp(spread, "set", "10", "12")).toEqual({ value: "12" });
    expect(applyOp(spread, "add", "10", "-2.5")).toEqual({ value: "7.5" });
    expect(applyOp(spread, "scale", "10", "1.2")).toEqual({ value: "12" });
  });
  it("keeps float noise out", () => {
    expect(applyOp(size, "add", "0.1", "0.2")).toEqual({ value: "0.3" });
    expect(applyOp(size, "scale", "7", "1.1")).toEqual({ value: "7.7" });
  });
  it("rounds integers", () => {
    expect(applyOp(levels, "scale", "3", "1.5")).toEqual({ value: "5" });
  });
  it("refuses what isn't a number, and scaling by zero or less", () => {
    expect(applyOp(spread, "set", "10", "abc")).toEqual({ error: "enter a number" });
    expect(applyOp(spread, "scale", "10", "0")).toEqual({ error: "scale by more than 0" });
  });
  it("allows set and add only when every book reads the value in one unit", () => {
    expect(opAllowed("set", ["USD", "USD"])).toBe(true);
    expect(opAllowed("add", ["BTC", "USD"])).toBe(false);
    expect(opAllowed("scale", ["BTC", "USD"])).toBe(true);
  });
});
