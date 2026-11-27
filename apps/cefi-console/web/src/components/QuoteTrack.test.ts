import { describe, expect, it } from "vitest";
import type { OrderRow } from "../../../shared/api.ts";
import { layoutTrack, TRACK_BPS } from "./QuoteTrack.tsx";

const order = (id: string, side: "BUY" | "SELL", price: string, status: OrderRow["status"] = "ACTIVE"): OrderRow => ({
  orderId: id,
  externalId: "",
  symbol: "X-USDC",
  side,
  type: "LIMIT",
  tif: "GTC",
  status,
  price,
  qty: "1",
  leavesQty: "1",
  executedQty: "0",
  createdNs: "0",
  updatedNs: "0",
});

describe("quote track layout", () => {
  it("places orders by bps behind their own touch", () => {
    // Mid 100, spread 20 bps.
    const t = layoutTrack(99.9, 100.1, [order("a", "BUY", "99.9"), order("b", "BUY", "99.4"), order("c", "SELL", "100.6"), order("d", "SELL", "120")])!;
    expect(t.spreadBps).toBeCloseTo(20);
    expect(t.bidAt).toBeCloseTo(47);
    expect(t.askAt).toBeCloseTo(53);
    const by = Object.fromEntries(t.markers.map((m) => [m.orderId, m]));
    expect(by.a!.atTouch).toBe(true);
    expect(by.a!.pos).toBeCloseTo(t.bidAt);
    expect(by.b!.behindBps).toBeCloseTo(50);
    expect(by.b!.pos).toBeLessThan(t.bidAt);
    expect(by.c!.behindBps).toBeCloseTo(50);
    expect(by.c!.pos).toBeCloseTo(100 - by.b!.pos);
    // Far out: pinned to the end of the track.
    expect(by.d!.clipped).toBe(true);
    expect(by.d!.pos).toBeCloseTo(100);
    expect(by.d!.behindBps).toBeGreaterThan(TRACK_BPS);
  });

  it("skips closed orders and books without a two-sided quote", () => {
    expect(layoutTrack(0, 100, [])).toBeUndefined();
    expect(layoutTrack(99, 101, [order("x", "BUY", "98", "FILLED")])!.markers).toEqual([]);
  });

  it("caps the gap for a wide spread", () => {
    const t = layoutTrack(90, 110, [])!;
    expect(t.askAt - t.bidAt).toBeCloseTo(22);
  });

  it("places the mid inside the spread by price, and outside it on the order scale", () => {
    // Mid 100, spread 20 bps: touch marks at 47 and 53.
    expect(layoutTrack(99.9, 100.1, [], 100)!.midAt).toBeCloseTo(50);
    expect(layoutTrack(99.9, 100.1, [], 99.95)!.midAt).toBeCloseTo(48.5);
    // 10 bps under the bid: 10/70 of the way from the bid mark to the end.
    expect(layoutTrack(99.9, 100.1, [], 99.8)!.midAt).toBeCloseTo(47 - (10 / TRACK_BPS) * 47, 1);
    expect(layoutTrack(99.9, 100.1, [])!.midAt).toBeUndefined();
  });
});
