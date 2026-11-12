import { compareDecimal, floorDecimal, fractionDigits, fromUnits, toUnits } from "../../shared/amount.ts";
import { BELOW_MINIMUM_MESSAGE, MINIMUM_USD, sellableAmount, worthAtLeastMinimum } from "../../shared/trade-rules.ts";
import { POSITIVE_DECIMAL } from "../../shared/validation.ts";
import type { Side } from "./types.ts";

const USD_DECIMALS = 2;

export interface TradeAsset {
  symbol: string;
  decimals: number;
}

// What safekeeping holds of the cash side and of the asset being traded.
export interface Safekeeping {
  usdc: string;
  asset: string;
}

export interface Chip {
  label: string;
  amount: string;
}

const PERCENTS = [25n, 50n, 75n, 100n] as const;
const chipLabel = (pct: bigint) => (pct === 100n ? "Max" : `${pct}%`);

// Shares of the cash available, rounded down to the cent. All four show, so the row stays put as the balance changes.
export function buyChips(usdc: string): Chip[] {
  const units = toUnits(floorDecimal(usdc, USD_DECIMALS), USD_DECIMALS);
  return PERCENTS.map((pct) => ({ label: chipLabel(pct), amount: fromUnits((units * pct) / 100n, USD_DECIMALS) })).filter(
    (chip) => compareDecimal(chip.amount, "0") > 0,
  );
}

// A chip whose amount would be refused as under the minimum trade is shown greyed out.
export function chipBelowMinimum(side: Side, amount: string, price: string | null, asset: TradeAsset): boolean {
  if (side === "buy") return compareDecimal(amount, MINIMUM_USD) < 0;
  return price === null || !worthAtLeastMinimum(amount, price, asset.decimals);
}

// Shares of what can be sold. Partial chips round down to 2 decimals; Max is the exact amount, so it never falls under the minimum trade through rounding.
export function sellChips(asset: TradeAsset, balance: string): Chip[] {
  const sellable = sellableAmount(asset.symbol, balance);
  const scale = fractionDigits(sellable);
  const units = toUnits(sellable, scale);
  const step = 10n ** BigInt(Math.max(asset.decimals - 2, 0));
  return PERCENTS.map((pct) => {
    if (pct === 100n) return { label: chipLabel(pct), amount: sellable };
    const atAssetPrecision = (units * 10n ** BigInt(asset.decimals)) / 10n ** BigInt(scale);
    return { label: chipLabel(pct), amount: fromUnits(((atAssetPrecision * pct) / 100n / step) * step, asset.decimals) };
  }).filter((chip) => compareDecimal(chip.amount, "0") > 0);
}

// An on-screen estimate only: the order is priced by the market when it runs.
export function estimate(side: Side, amount: string, price: string | null, symbol: string): string | null {
  if (!POSITIVE_DECIMAL.test(amount) || price === null) return null;
  const p = Number(price);
  if (!(p > 0)) return null;
  if (side === "sell") return `About ${(Number(amount) * p).toFixed(2)} USDC`;
  const got = Number(amount) / p;
  return `About ${got.toLocaleString("en-US", { maximumFractionDigits: got >= 1000 ? 0 : 4 })} ${symbol}`;
}

// Mirrors the server's checks so the advisor sees the same words before placing.
export function validate(
  side: Side,
  amount: string,
  safekeeping: Safekeeping,
  price: string | null,
  asset: TradeAsset,
): string | null {
  if (!POSITIVE_DECIMAL.test(amount)) return "Enter an amount.";
  if (side === "buy") {
    if (fractionDigits(amount) > USD_DECIMALS) return "Use at most 2 decimal places.";
    if (compareDecimal(amount, MINIMUM_USD) < 0) return BELOW_MINIMUM_MESSAGE;
    if (compareDecimal(amount, safekeeping.usdc) > 0) return `Only ${safekeeping.usdc} USDC in the client wallet.`;
    return null;
  }
  if (fractionDigits(amount) > asset.decimals) return `Use at most ${asset.decimals} decimal places.`;
  if (price === null) return `The ${asset.symbol} price is not available yet. Try again in a moment.`;
  if (!worthAtLeastMinimum(amount, price, asset.decimals)) return BELOW_MINIMUM_MESSAGE;
  const sellable = sellableAmount(asset.symbol, safekeeping.asset);
  if (compareDecimal(amount, sellable) > 0) return `Only ${sellable} ${asset.symbol} in the client wallet.`;
  return null;
}
