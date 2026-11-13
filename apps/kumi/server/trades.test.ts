import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDataDir } from "./testing.ts";

const tempDir = useTempDataDir("kumi-trades-");

function legacyTrade() {
  return {
    id: "t-old",
    household_id: "hh-1",
    side: "buy",
    usd: "10",
    status: "complete",
    steps: [],
    placed_by: "Hana Sato",
    created_at: "2026-11-11T10:00:00Z",
    move_in: { amount: "10", asset: "USDC" },
    order: {},
    transfer: {},
  };
}

describe("trade store", () => {
  it("reads a trade saved without an asset as a SOL trade", async () => {
    mkdirSync(tempDir.dir, { recursive: true });
    writeFileSync(join(tempDir.dir, "trades.json"), JSON.stringify({ trades: [legacyTrade()] }));
    const { tradeStore } = await import("./trades.ts");

    expect(tradeStore.get("t-old")?.asset).toBe("SOL");
    expect(tradeStore.latestForHousehold("hh-1")?.asset).toBe("SOL");
  });

  it("keeps the asset a trade was created with", async () => {
    const { newTrade, tradeStore } = await import("./trades.ts");
    tradeStore.create(
      newTrade({ id: "t-new", household_id: "hh-1", side: "sell", asset: "JUP", qty: "12", placed_by: "Hana Sato", now: "2026-11-11T10:00:00Z" }),
    );

    expect(tradeStore.get("t-new")).toMatchObject({ asset: "JUP", move_in: { asset: "JUP", amount: "12" } });
  });
});
