import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prices, startPricePoller, stopPricePoller } from "./prices.ts";
import type { PriceHistoryResponse } from "./tm/types.ts";

function history(...values: string[]): PriceHistoryResponse {
  return {
    symbol: "SOL",
    window: "24h",
    resolution: "5m",
    points: values.map((price, i) => ({ t: `2026-11-11T10:${String(i).padStart(2, "0")}:00Z`, price })),
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  stopPricePoller();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startPricePoller", () => {
  it("serves the last point for SOL", async () => {
    const fetchHistory = vi.fn(async () => history("180", "182.44"));

    startPricePoller(["SOL"], 15_000, fetchHistory);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchHistory).toHaveBeenCalledWith("SOL");
    expect(prices.get("SOL")).toEqual({ price: "182.44", as_of: "2026-11-11T10:01:00Z" });
  });

  it("reads null before SOL ever priced", async () => {
    startPricePoller(["SOL"], 15_000, vi.fn(async () => history()));
    await vi.advanceTimersByTimeAsync(0);

    expect(prices.get("SOL")).toEqual({ price: null, as_of: null });
  });

  it("keeps the last price through a failure streak and logs it once", async () => {
    const fetchHistory = vi
      .fn<(symbol: string) => Promise<PriceHistoryResponse>>()
      .mockResolvedValueOnce(history("182.44"))
      .mockRejectedValue(new Error("unavailable"));

    startPricePoller(["SOL"], 15_000, fetchHistory);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchHistory).toHaveBeenCalledTimes(3);
    expect(prices.get("SOL").price).toBe("182.44");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
