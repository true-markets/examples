import { describe, expect, it } from "vitest";
import { kindFacets, matchesKind } from "./trade-kinds.ts";

const rows = [
  { kind: "maker", level: 1 },
  { kind: "maker", level: 0 },
  { kind: "maker", level: 0 },
  { kind: "takeout", level: -1 },
];

describe("trade kinds", () => {
  it("lists maker, then each level, then the take kinds", () => {
    expect(kindFacets(rows)).toEqual([
      { value: "maker", count: 3 },
      { value: "maker L0", count: 2 },
      { value: "maker L1", count: 1 },
      { value: "takeout", count: 1 },
    ]);
  });
  it("takes every level for maker and one level for maker Ln", () => {
    expect(rows.filter((r) => matchesKind(r, ["maker"]))).toHaveLength(3);
    expect(rows.filter((r) => matchesKind(r, ["maker L0"]))).toHaveLength(2);
    expect(rows.filter((r) => matchesKind(r, ["maker L1", "takeout"]))).toHaveLength(2);
    expect(rows.filter((r) => matchesKind(r, []))).toHaveLength(4);
  });
});
