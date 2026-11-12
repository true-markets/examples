import { plusDecimal } from "../../shared/amount.ts";
import type { AssetRow, Holding } from "./types.ts";

export interface Position {
  symbol: string;
  name: string;
  icon: string | null;
  price: number | null;
  safekeeping: string;
  trading: string | null;
  // Safekeeping plus whatever is in the trading wallet.
  quantity: string;
  // Held in the trading wallet right now, so only while a trade is running.
  inTransit: string | null;
  // Null while the asset has no price yet.
  value: number | null;
}

export function amountIn(holding: Holding | null, symbol: string): string | null {
  if (!holding) return null;
  if (symbol === "SOL") return holding.sol;
  if (symbol === "USDC") return holding.usdc;
  return holding.tokens[symbol] ?? "0";
}

export const held = (amount: string | null) => Number(amount ?? 0) > 0;

// True when a wallet holds none of anything.
export function isEmpty(holding: Holding): boolean {
  return !held(holding.sol) && !held(holding.usdc) && Object.values(holding.tokens).every((a) => !held(a));
}

export function assetBySymbol(assets: readonly AssetRow[] | undefined, symbol: string): AssetRow | undefined {
  return assets?.find((a) => a.symbol === symbol);
}

// USDC is always the mid grey and the rest step down from ink, so a legend never relies on colour alone.
const USDC_COLOR = "#6b7280";
const TOKEN_COLORS = ["#0c0f14", "#2f3744", "#4a5361", "#8b919c", "#adb2bb"];

export function allocationColors(symbols: readonly string[]): Record<string, string> {
  let next = 0;
  return Object.fromEntries(symbols.map((s) => [s, s === "USDC" ? USDC_COLOR : TOKEN_COLORS[next++ % TOKEN_COLORS.length]!]));
}

// USDC and SOL always show; any other token shows once either wallet holds some of it.
export function positions(safekeeping: Holding, trading: Holding | null, assets: readonly AssetRow[]): Position[] {
  const bySymbol = new Map(assets.map((a) => [a.symbol, a]));
  const priceOf = (symbol: string) => {
    const quote = bySymbol.get(symbol)?.price;
    return quote === null || quote === undefined ? null : Number(quote);
  };
  const iconOf = (symbol: string) => bySymbol.get(symbol)?.icon ?? null;
  const row = (symbol: string, name: string, price: number | null): Position => {
    const s = amountIn(safekeeping, symbol)!;
    const t = amountIn(trading, symbol);
    const quantity = plusDecimal(s, t ?? "0");
    return {
      symbol,
      name,
      icon: iconOf(symbol),
      price,
      safekeeping: s,
      trading: t,
      quantity,
      inTransit: held(t) ? t : null,
      value: price === null ? null : Number(quantity) * price,
    };
  };
  const others = assets
    .filter((a) => !a.cash && a.symbol !== "SOL" && (held(amountIn(safekeeping, a.symbol)) || held(amountIn(trading, a.symbol))))
    .map((a) => row(a.symbol, a.name, priceOf(a.symbol)));
  return [row("USDC", "US dollar stablecoin", 1), row("SOL", "Solana", priceOf("SOL")), ...others];
}

// Each asset's share of what the household holds, as whole percentages. Empty while any held asset is unpriced.
export function allocation(rows: readonly Position[]): { symbol: string; pct: number }[] {
  if (rows.some((r) => r.value === null && (held(r.safekeeping) || held(r.trading)))) return [];
  const total = rows.reduce((sum, r) => sum + (r.value ?? 0), 0);
  if (total <= 0) return [];
  return rows
    .filter((r) => (r.value ?? 0) > 0)
    .map((r) => ({ symbol: r.symbol, pct: Math.round(((r.value ?? 0) / total) * 100) }));
}

export interface AllocationChange {
  symbol: string;
  before: number;
  after: number;
}

// How a trade would move the client's mix, for the two assets it touches. An estimate: fees and price moves are left out.
// Null when a held asset has no price or nothing is held, so there is no honest percentage to show.
export function allocationAfter(
  rows: readonly Position[],
  side: "buy" | "sell",
  symbol: string,
  amountUsd: number,
): AllocationChange[] | null {
  if (rows.some((r) => r.value === null && held(r.quantity))) return null;
  const total = rows.reduce((sum, r) => sum + (r.value ?? 0), 0);
  if (!(total > 0) || !(amountUsd > 0)) return null;

  const valueOf = (s: string) => rows.find((r) => r.symbol === s)?.value ?? 0;
  const pct = (value: number) => Math.round((Math.max(0, value) / total) * 100);
  const move = side === "buy" ? -amountUsd : amountUsd;
  return [
    { symbol, before: pct(valueOf(symbol)), after: pct(valueOf(symbol) - move) },
    { symbol: "USDC", before: pct(valueOf("USDC")), after: pct(valueOf("USDC") + move) },
  ];
}
