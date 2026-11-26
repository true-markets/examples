import { describe, expect, it } from "vitest";
import type { QuoterDeskStatus } from "../../shared/api.ts";
import { openPnl } from "./open-pnl.ts";

const book = (base: string, position: string, extra: Record<string, unknown> = {}) => ({
  market: { symbol: `${base}-USDC`, baseSymbol: base, quoteSymbol: "USDC", baseAssetId: base.toLowerCase(), quoteAssetId: "usdc" },
  position,
  avgCost: "100",
  positionSince: "2026-11-22T14:05:00Z",
  reference: "101",
  realizedPnl: "0",
  unrealizedPnl: "0",
  ...extra,
});

const desk = (books: ReturnType<typeof book>[], balances: { assetId: string; symbol: string; spendable: string; price: string | null }[]) =>
  ({ books, balances, totals: [{ quote: "USDC", unrealizedPnl: "-0.35" }] }) as unknown as QuoterDeskStatus;

describe("openPnl", () => {
  it("counts a book's own position marked to its reference, biggest first", () => {
    const r = openPnl(
      desk(
        [book("TSLA", "-0.025", { unrealizedPnl: "-0.001" }), book("AMZNC", "0.343", { avgCost: "256.904", reference: "255.88", unrealizedPnl: "-0.351" })],
        [],
      ),
    );
    expect(r.counted.map((c) => c.symbol)).toEqual(["AMZNC-USDC", "TSLA-USDC"]);
    expect(r.counted[0]!.open).toBe(-0.351);
    expect(r.counted[0]!.moveBps).toBeCloseTo(-39.86, 1);
    expect(r.totals).toEqual([{ quote: "USDC", open: -0.35 }]);
  });

  it("says why the rest adds nothing: flat, no reference, or held outside the books", () => {
    const r = openPnl(
      desk(
        [book("NVDA", "0", { realizedPnl: "0.4" }), book("PLTRC", "0.12", { reference: null }), book("AMZNC", "0.343")],
        [
          { assetId: "amznc", symbol: "AMZNC", spendable: "0.52", price: "255.88" },
          { assetId: "nvda", symbol: "NVDA", spendable: "0", price: "186" },
          { assetId: "pltrc", symbol: "PLTRC", spendable: "0.12", price: null },
        ],
      ),
    );
    expect(r.counted.map((c) => c.symbol)).toEqual(["AMZNC-USDC"]);
    expect(r.notCounted.map((n) => n.kind)).toEqual(["flat", "no-reference", "outside"]);
    const out = r.notCounted[2]!;
    expect(out.kind === "outside" && out.asset).toBe("AMZNC");
    expect(out.kind === "outside" && out.outside).toBeCloseTo(0.177, 9);
    expect(out.kind === "outside" && out.valueUsd).toBeCloseTo(0.177 * 255.88, 6);
  });

  it("counts a book that sold out of holdings as negative, leaving the holdings outside", () => {
    const r = openPnl(desk([book("TSLA", "-0.025")], [{ assetId: "tsla", symbol: "TSLA", spendable: "0.975", price: "387" }]));
    const out = r.notCounted[0]!;
    expect(out.kind === "outside" && [out.account, out.inBooks, out.outside]).toEqual([0.975, -0.025, 1]);
  });

  it("leaves the move blank for a quoter too old to send the average cost", () => {
    const r = openPnl(desk([book("TSLA", "1", { avgCost: undefined })], []));
    expect(r.counted[0]!.avgCost).toBeNull();
    expect(r.counted[0]!.moveBps).toBeNull();
  });
});
