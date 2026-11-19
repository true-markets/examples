import { describe, expect, it } from "vitest";
import { sizeOrder, type SizeInput } from "./order-size.ts";

const base: SizeInput = { venue: "CEFI", side: "BUY", type: "LIMIT", unit: "USD", amount: "250", limitPrice: 382.1, bid: 382, ask: 382.2, base: "TSLA" };

describe("sizeOrder", () => {
  it("CeFi limit in USD rounds the quantity down to the exchange's lot", () => {
    const s = sizeOrder(base);
    // 250 / 382.1 = 0.65428…, down to the 0.001 lot for $10–$999.999; never more than $250.
    expect(s).toMatchObject({ ok: true, qty: "0.654", quoteQty: false });
    expect(Number((s as { qty: string }).qty) * 382.1).toBeLessThanOrEqual(250);
  });

  it("CeFi limit in USD needs a price and a big enough amount", () => {
    expect(sizeOrder({ ...base, limitPrice: undefined })).toMatchObject({ ok: false });
    expect(sizeOrder({ ...base, amount: "0.1" })).toMatchObject({ ok: false });
  });

  it("CeFi market in USD is sent as USD with QUOTE_QTY", () => {
    expect(sizeOrder({ ...base, type: "MARKET" })).toMatchObject({ ok: true, qty: "250", quoteQty: true });
  });

  it("a quantity goes through as typed on CeFi, if it fits the lot", () => {
    expect(sizeOrder({ ...base, unit: "QTY", amount: "0.5" })).toMatchObject({ ok: true, qty: "0.5", quoteQty: false });
    expect(sizeOrder({ ...base, unit: "QTY", amount: "0.505" })).toMatchObject({ ok: true, qty: "0.505" });
    expect(sizeOrder({ ...base, unit: "QTY", amount: "0.5055" })).toMatchObject({ ok: false });
  });

  it("checks the tick and the $1 minimum on CeFi", () => {
    expect(sizeOrder({ ...base, limitPrice: 382.1005 })).toMatchObject({ ok: false });
    expect(sizeOrder({ ...base, type: "MARKET", amount: "0.5" })).toMatchObject({ ok: false });
    // 0.01 of a $50 asset is $0.50, under the minimum.
    expect(sizeOrder({ ...base, unit: "QTY", amount: "0.01", limitPrice: 50 })).toMatchObject({ ok: false });
    // At $1,000 and up the lot is 0.001.
    expect(sizeOrder({ ...base, amount: "250", limitPrice: 1500 })).toMatchObject({ ok: true, qty: "0.166" });
  });

  it("DeFi buys are always sent in USDC, converting a quantity at the ask", () => {
    expect(sizeOrder({ ...base, venue: "DEFI", type: "MARKET" })).toMatchObject({ ok: true, qty: "250", quoteQty: true });
    // 0.5 × 382.2 = 191.10
    expect(sizeOrder({ ...base, venue: "DEFI", type: "MARKET", unit: "QTY", amount: "0.5" })).toMatchObject({ ok: true, qty: "191.1", quoteQty: true });
  });

  it("DeFi sells are always sent in the asset, converting USD at the bid", () => {
    // 100 / 382 = 0.261780…, to the token's decimals (8 when unknown)
    expect(sizeOrder({ ...base, venue: "DEFI", type: "MARKET", side: "SELL", amount: "100" })).toMatchObject({ ok: true, qty: "0.2617801", quoteQty: false });
    expect(sizeOrder({ ...base, venue: "DEFI", type: "MARKET", side: "SELL", unit: "QTY", amount: "0.2" })).toMatchObject({ ok: true, qty: "0.2" });
    expect(sizeOrder({ ...base, venue: "DEFI", type: "MARKET", side: "SELL", bid: undefined })).toMatchObject({ ok: false });
  });

  it("DeFi ignores the exchange's increments and uses only on-chain precision", () => {
    const defi = { ...base, venue: "DEFI" as const, type: "MARKET" as const, defiDecimals: 8 };
    // Not rounded to cents, and no $1 minimum: USDC goes to 6 decimals.
    expect(sizeOrder({ ...defi, amount: "0.123456" })).toMatchObject({ ok: true, qty: "0.123456", quoteQty: true });
    expect(sizeOrder({ ...defi, amount: "0.1234567" })).toMatchObject({ ok: false });
    // A sell converted from USD keeps the token's 8 decimals: 100 / 382 = 0.26178010…
    expect(sizeOrder({ ...defi, side: "SELL", amount: "100" })).toMatchObject({ ok: true, qty: "0.2617801" });
    // A typed quantity finer than the token is refused, and anything else passes, even odd lots.
    expect(sizeOrder({ ...defi, side: "SELL", unit: "QTY", amount: "0.123456789" })).toMatchObject({ ok: false });
    expect(sizeOrder({ ...defi, side: "SELL", unit: "QTY", amount: "0.00012345" })).toMatchObject({ ok: true, qty: "0.00012345" });
  });

  it("rejects empty or malformed amounts", () => {
    for (const amount of ["", "0", "-5", "abc", "1e3"]) expect(sizeOrder({ ...base, amount }).ok).toBe(false);
    expect(sizeOrder({ ...base, venue: "DEFI", type: "MARKET", amount: ".5" })).toMatchObject({ ok: true, qty: "0.5" });
  });
});
