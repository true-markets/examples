import { describe, expect, it } from "vitest";
import { floorToStep, incrementsFor, isMultiple, stepDecimals } from "./increments.ts";

describe("increments", () => {
  it("picks the bucket by price, including its edges", () => {
    // $10–$999.999 follows the live exchange's 0.001 lot rather than the table's 0.01.
    expect(incrementsFor(382.2)).toMatchObject({ tick: 0.001, lot: 0.001 });
    expect(incrementsFor(999.999)).toMatchObject({ tick: 0.001, lot: 0.001 });
    expect(incrementsFor(10)).toMatchObject({ tick: 0.001, lot: 0.001 });
    expect(incrementsFor(1_000)).toMatchObject({ tick: 0.01, lot: 0.001 });
    expect(incrementsFor(91_000)).toMatchObject({ tick: 0.1, lot: 0.0001 });
    expect(incrementsFor(9.9999)).toMatchObject({ tick: 0.0001, lot: 1 });
    expect(incrementsFor(0.05)).toMatchObject({ tick: 0.000001, lot: 100 });
    expect(incrementsFor(0.000001)).toMatchObject({ lot: 1_000_000 });
    expect(incrementsFor(600_000)).toMatchObject({ tick: 1, lot: 0.000001, minNotional: 1 });
  });

  it("rounds down to the step and checks multiples despite float noise", () => {
    expect(floorToStep(250 / 379.25, 0.01)).toBe("0.65");
    expect(floorToStep(0.3 / 0.1, 1)).toBe("3");
    expect(floorToStep(12_345, 100)).toBe("12300");
    expect(isMultiple(382.207, 0.001)).toBe(true);
    expect(isMultiple(382.2075, 0.001)).toBe(false);
    expect(isMultiple(0.07, 0.01)).toBe(true);
    expect(stepDecimals(0.0001)).toBe(4);
    expect(stepDecimals(100)).toBe(0);
  });
});
