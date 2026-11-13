import { describe, expect, it } from "vitest";
import { loadAssets, matchBalance, symbolOf } from "./assets.ts";
import { assetItem, balanceRow, JUP_MINT, SOL_MINT, testCatalog, USDC_MINT } from "./testing.ts";
import type { AssetItem, Page } from "./tm/types.ts";

function page(...items: AssetItem[]): () => Promise<Page<AssetItem>> {
  return async () => ({ data: items, pagination: { next_cursor: null, limit: 100 } });
}

const SOL = assetItem("SOL", "solana", SOL_MINT, 9);
const USDC = assetItem("USDC", "solana", USDC_MINT);
const BASE_USDC = assetItem("USDC", "base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

const JUP = assetItem("JUP", "solana", JUP_MINT);

describe("loadAssets", () => {
  it("keeps the Solana listings of SOL, USDC and the configured tokens", async () => {
    const catalog = await loadAssets(page(BASE_USDC, USDC, JUP, SOL), ["SOL", "JUP"]);

    const sol = { id: "SOL-solana", symbol: "SOL", name: "SOL", mint: SOL_MINT, decimals: 9, icon: null };
    expect(catalog).toEqual({
      sol,
      usdc: { id: "USDC-solana", symbol: "USDC", name: "USDC", mint: USDC_MINT, decimals: 6, icon: null },
      tokens: [sol, { id: "JUP-solana", symbol: "JUP", name: "JUP", mint: JUP_MINT, decimals: 6, icon: null }],
    });
  });

  it("always offers SOL first, even when the list leaves it out", async () => {
    const catalog = await loadAssets(page(USDC, JUP, SOL), ["JUP"]);

    expect(catalog.tokens.map((t) => t.symbol)).toEqual(["SOL", "JUP"]);
  });

  it("throws naming a configured token that is not listed on solana", async () => {
    await expect(loadAssets(page(USDC, SOL), ["SOL", "JUP"])).rejects.toThrow("no JUP on solana");
  });

  it("throws for a listed token that is not tradeable", async () => {
    await expect(loadAssets(page(USDC, SOL, { ...JUP, tradeable: false }), ["SOL", "JUP"])).rejects.toThrow(
      "does not offer JUP for trading",
    );
  });

  it("throws when SOL is not listed on solana", async () => {
    await expect(loadAssets(page(USDC, assetItem("SOL", "base", "0xsol")), ["SOL"])).rejects.toThrow("no SOL on solana");
  });

  it("throws when USDC is not listed on solana", async () => {
    await expect(loadAssets(page(SOL, BASE_USDC), ["SOL"])).rejects.toThrow("no USDC on solana");
  });
});

describe("matchBalance", () => {
  it("matches a row by asset_id", () => {
    const row = balanceRow("SOL", "1", { address: "something-else" });

    expect(matchBalance([row], testCatalog.sol)).toBe(row);
  });

  it("falls back to the mint on solana", () => {
    const row = balanceRow("USDC", "5", { asset_id: undefined });

    expect(matchBalance([row], testCatalog.usdc)).toBe(row);
  });

  it("ignores the same address on another chain", () => {
    const row = balanceRow("USDC", "5", { asset_id: "usdc-base", chain: "base" });

    expect(matchBalance([row], testCatalog.usdc)).toBeUndefined();
  });
});

describe("symbolOf", () => {
  it("names a catalog mint and keeps an unknown one raw", () => {
    expect(symbolOf(testCatalog, USDC_MINT)).toBe("USDC");
    expect(symbolOf(testCatalog, "UnknownMint111")).toBe("UnknownMint111");
  });
});
