import { verify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { AssetCatalog, CatalogAsset } from "./assets.ts";
import type { Household } from "./households.ts";
import { signerPublicKey } from "./tm/stamp.ts";
import type { AssetItem, BalanceItem, OrganizationUser } from "./tm/types.ts";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const SAFEKEEPING_ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
export const TRADING_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

export const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

const SOL: CatalogAsset = { id: "sol-id", symbol: "SOL", name: "Solana", mint: SOL_MINT, decimals: 9, icon: null };
const JUP: CatalogAsset = { id: "jup-id", symbol: "JUP", name: "Jupiter", mint: JUP_MINT, decimals: 6, icon: null };

export const testCatalog: AssetCatalog = {
  sol: SOL,
  usdc: { id: "usdc-id", symbol: "USDC", name: "USD Coin", mint: USDC_MINT, decimals: 6, icon: null },
  tokens: [SOL, JUP],
};

export function assetItem(symbol: string, chain: string, address: string, decimals = 6): AssetItem {
  return {
    id: `${symbol}-${chain}`,
    chain,
    address,
    symbol,
    name: symbol,
    decimals,
    icon: null,
    tradeable: true,
    stable: symbol === "USDC",
    venue: "defi",
  };
}

export function balanceRow(symbol: string, available: string, overrides: Partial<BalanceItem> = {}): BalanceItem {
  const asset = [...testCatalog.tokens, testCatalog.usdc].find((a) => a.symbol === symbol)!;
  return {
    asset_id: asset.id,
    symbol,
    name: symbol,
    venue: "defi",
    chain: "solana",
    address: asset.mint,
    decimals: asset.decimals,
    total: available,
    available,
    held: "0",
    stable: symbol === "USDC",
    tradeable: true,
    ...overrides,
  };
}

export function decodeStamp(value: string): Record<string, string> {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, string>;
}

export function verifiesStamp(stamp: string, payload: string): boolean {
  const der = Buffer.from(decodeStamp(stamp).signature ?? "", "hex");
  return verify("sha256", Buffer.from(payload), signerPublicKey, der);
}

export function testHousehold(overrides: Partial<Household> = {}): Household {
  return {
    id: "hh-1",
    org_id: "org-1",
    name: "Ōtomo and Hana Fujiwara",
    created_at: "2026-11-01T10:00:00Z",
    safekeeping_address: SAFEKEEPING_ADDRESS,
    trading_user_id: "user-1",
    trading_address: TRADING_ADDRESS,
    ready: true,
    ...overrides,
  };
}

export function organizationUser(ref: string): OrganizationUser {
  return {
    user_id: `user-${ref}`,
    external_ref_id: ref,
    created_at: "2026-11-11T10:00:00Z",
    wallets: [
      { chain_family: "EVM", address: "0x3fA9b1C47e0D2a8F5E6c9B04d71A2F8e5b3Cc21E" },
      { chain_family: "SOLANA", address: TRADING_ADDRESS },
    ],
  };
}

export function useTempDataDir(prefix: string, sub?: string): { readonly dir: string } {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), prefix));
    if (sub) dir = join(dir, sub);
    vi.stubEnv("DATA_DIR", dir);
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  return {
    get dir() {
      return dir;
    },
  };
}
