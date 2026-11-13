import { env } from "./env.ts";
import { listAssets } from "./tm/gateway.ts";
import type { BalanceItem } from "./tm/types.ts";

export interface CatalogAsset {
  id: string;
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  icon: string | null;
}

export interface AssetCatalog {
  sol: CatalogAsset;
  usdc: CatalogAsset;
  // Every asset offered for trading, SOL first. USDC is the cash side of every trade and is not in this list.
  tokens: CatalogAsset[];
}

let catalog: AssetCatalog | undefined;

export async function loadAssets(fetchAssets = listAssets, symbols: readonly string[] = env.TM_TOKENS): Promise<AssetCatalog> {
  const { data } = await fetchAssets();
  const find = (symbol: string): CatalogAsset => {
    const item = data.find((a) => a.symbol.toUpperCase() === symbol && a.chain === "solana");
    if (!item?.address) throw new Error(`True Markets lists no ${symbol} on solana`);
    if (!item.tradeable && symbol !== "USDC") throw new Error(`True Markets does not offer ${symbol} for trading`);
    return { id: item.id, symbol, name: item.name, mint: item.address, decimals: item.decimals, icon: item.icon };
  };
  const sol = find("SOL");
  const others = symbols.filter((s) => s !== "SOL" && s !== "USDC").map(find);
  catalog = { sol, usdc: find("USDC"), tokens: [sol, ...others] };
  return catalog;
}

export const assets: AssetCatalog = {
  get sol() {
    return catalog!.sol;
  },
  get usdc() {
    return catalog!.usdc;
  },
  get tokens() {
    return catalog!.tokens;
  },
};

export function tokenBySymbol(catalog: AssetCatalog, symbol: string): CatalogAsset | undefined {
  return catalog.tokens.find((a) => a.symbol === symbol);
}

// Quotes name assets by mint; a mint outside the catalog stays as its raw address.
export function symbolOf(catalog: AssetCatalog, mint: string): string {
  return [...catalog.tokens, catalog.usdc].find((a) => a.mint === mint)?.symbol ?? mint;
}

export function matchBalance(rows: readonly BalanceItem[], asset: CatalogAsset): BalanceItem | undefined {
  return rows.find((r) => r.asset_id === asset.id) ?? rows.find((r) => r.chain === "solana" && r.address === asset.mint);
}
