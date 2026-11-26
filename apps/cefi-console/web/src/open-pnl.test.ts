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

const desk = (books: ReturnType<typeof book>[], balances: { assetId: string; symbol: string; spendable: string; price: string | null }[] = []) =>
  ({ books, balances, totals: [{ quote: "USDC", unrealizedPnl: "-0.35" }] }) as unknown as QuoterDeskStatus;

describe("openPnl", () => {
  it("marks each book's own position to its reference, biggest first", () => {
    const r = openPnl(
      desk([book("TSLA", "-0.025", { unrealizedPnl: "-0.001" }), book("AMZNC", "0.343", { avgCost: "256.904", reference: "255.88", unrealizedPnl: "-0.351" })]),
    );
    expect(r.rows.map((x) => x.symbol)).toEqual(["AMZNC-USDC", "TSLA-USDC"]);
    expect(r.rows[0]!.open).toBe(-0.351);
    expect(r.rows[0]!.moveBps).toBeCloseTo(-39.86, 1);
    expect(r.totals).toEqual([{ quote: "USDC", open: -0.35 }]);
  });

  it("gives each book the account's holding beyond the books as its starting position", () => {
    const r = openPnl(desk([book("AMZNC", "0.343")], [{ assetId: "amznc", symbol: "AMZNC", spendable: "0.52", price: "255.88" }]));
    expect(r.rows[0]!.starting).toBeCloseTo(0.177, 9);
    expect(r.rows[0]!.sharedStart).toBe(false);
  });

  it("counts a book that sold out of holdings as negative, starting from what was there", () => {
    const r = openPnl(desk([book("TSLA", "-0.025")], [{ assetId: "tsla", symbol: "TSLA", spendable: "0.975", price: "387" }]));
    expect(r.rows[0]!.starting).toBe(1);
    expect(r.rows[0]!.position).toBe(-0.025);
  });

  it("lists flat and unpriced books after the rest, with nothing to mark", () => {
    const r = openPnl(desk([book("NVDA", "0", { realizedPnl: "0.4" }), book("PLTRC", "0.12", { reference: null }), book("AMZNC", "0.343")]));
    expect(r.rows.map((x) => [x.symbol, x.status])).toEqual([
      ["AMZNC-USDC", "counted"],
      ["PLTRC-USDC", "no-reference"],
      ["NVDA-USDC", "flat"],
    ]);
    const flat = r.rows[2]!;
    expect([flat.avgCost, flat.moveBps, flat.realized]).toEqual([null, null, 0.4]);
    expect(r.rows[1]!.mark).toBeNull();
  });

  it("marks the starting position shared when two books trade the same asset", () => {
    const b2 = { ...book("TSLA", "0.5"), market: { ...book("TSLA", "0").market, symbol: "TSLA-USDT" } };
    const r = openPnl(desk([book("TSLA", "0.25"), b2], [{ assetId: "tsla", symbol: "TSLA", spendable: "1", price: "387" }]));
    expect(r.rows.map((x) => [x.starting, x.sharedStart])).toEqual([
      [0.25, true],
      [0.25, true],
    ]);
  });

  it("leaves the starting position blank when the account's balance isn't known, and the move for an older quoter", () => {
    const r = openPnl(desk([book("TSLA", "1", { avgCost: undefined })]));
    expect(r.rows[0]!.starting).toBeNull();
    expect(r.rows[0]!.moveBps).toBeNull();
  });
});
