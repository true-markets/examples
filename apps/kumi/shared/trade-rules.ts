import { compareDecimal, fractionDigits, minusDecimal, toUnits } from "./amount.ts";

// The gateway refuses a transfer under $5, and the returning proceeds must clear it after the order fee and any price move.
export const MINIMUM_USD = "5.50";
export const BELOW_MINIMUM_MESSAGE = `Trades start at $${MINIMUM_USD}.`;
// Stays in safekeeping to pay the move-in's network fee and any token-account rent.
const GAS_RESERVE_SOL = "0.01";
export const SOL_DECIMALS = 9;

function sellableSol(sol: string): string {
  const left = minusDecimal(sol, GAS_RESERVE_SOL, SOL_DECIMALS);
  return compareDecimal(left, "0") > 0 ? left : "0";
}

// Only SOL keeps a reserve, to pay fees; any other token can be sold down to nothing.
export function sellableAmount(symbol: string, balance: string): string {
  return symbol === "SOL" ? sellableSol(balance) : balance;
}

export function worthAtLeastMinimum(qty: string, price: string, decimals: number): boolean {
  const priceScale = fractionDigits(price);
  return toUnits(qty, decimals) * toUnits(price, priceScale) >= toUnits(MINIMUM_USD, decimals + priceScale);
}
