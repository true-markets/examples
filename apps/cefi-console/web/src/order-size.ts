// Turns what you type in the ticket (an amount in USD, or a quantity of the asset) into what each
// route actually accepts, and says in plain words what will be sent.
//
//   CeFi market  USD → sent as USD with QUOTE_QTY; the exchange sizes it at entry.
//   CeFi limit   USD → USD ÷ limit price, rounded down to the exchange's lot for that price.
//   CeFi orders are checked against the exchange's tick, lot and minimum notional (shared/increments.ts).
//   DeFi buy     the gateway takes USDC to spend; a quantity is converted at the CeFi ask.
//   DeFi sell    the gateway takes the asset; a USD amount is converted at the CeFi bid.
//   DeFi has no exchange increments, only each token's on-chain decimals.

import { floorToStep, incrementsFor, isMultiple } from "../../shared/increments.ts";

export type SizeUnit = "USD" | "QTY";

export interface SizeInput {
  venue: "CEFI" | "DEFI";
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET";
  unit: SizeUnit;
  amount: string;
  limitPrice?: number;
  bid?: number;
  ask?: number;
  base: string;
  // DeFi only: the token's on-chain decimals, from the asset catalog.
  defiDecimals?: number;
}

export type Sized =
  | { ok: true; qty: string; quoteQty: boolean; describe: string }
  | { ok: false; describe: string };

const USDC_DECIMALS = 6;
// An 18-decimal token can't be computed exactly in a float, so conversions stop at 12 places;
// fewer decimals than the token allows is always valid.
const MAX_FLOAT_DECIMALS = 12;

export function sizeOrder(input: SizeInput): Sized {
  // ".5" becomes "0.5": amounts pass through as typed, and the API wants a leading digit.
  const i = { ...input, amount: input.amount.trim().replace(/^\./, "0.") };
  const amount = Number(i.amount);
  if (!(amount > 0) || !/^\d+(\.\d+)?$/.test(i.amount)) return { ok: false, describe: "" };
  const usdIn = i.unit === "USD";
  const touch = i.side === "BUY" ? i.ask : i.bid;
  const touchName = i.side === "BUY" ? "ask" : "bid";

  if (i.venue === "CEFI") {
    // The exchange's increments depend on the price: the limit price, or the touch for market.
    const refPx = i.type === "LIMIT" ? (i.limitPrice ?? 0) : (touch ?? 0);
    const inc = refPx > 0 ? incrementsFor(refPx) : undefined;
    if (i.type === "MARKET") {
      if (usdIn) {
        if (inc && amount < inc.minNotional) return { ok: false, describe: `The exchange's minimum order is ${usd(inc.minNotional)}` };
        const est = touch && inc ? ` (≈ ${trim(floorToStep(amount / touch, inc.lot))} ${i.base} at the ${touchName})` : "";
        return { ok: true, qty: trim(amount.toFixed(2)), quoteQty: true, describe: `Sends ${usd(amount)} at market; the exchange sizes it${est}` };
      }
      if (inc && !isMultiple(amount, inc.lot)) return { ok: false, describe: `Quantity must be a multiple of ${inc.lot} ${i.base} at this price` };
      if (touch && inc && amount * touch < inc.minNotional) return { ok: false, describe: `The exchange's minimum order is ${usd(inc.minNotional)}` };
      return { ok: true, qty: i.amount.trim(), quoteQty: false, describe: touch ? `≈ ${usd(amount * touch)} at the ${touchName}` : "" };
    }
    const px = i.limitPrice ?? 0;
    if (!(px > 0) || !inc) return { ok: false, describe: usdIn ? "Enter a limit price to size the order" : "" };
    if (!isMultiple(px, inc.tick)) return { ok: false, describe: `Price must be a multiple of ${inc.tick} at this level` };
    const qty = usdIn ? floorToStep(amount / px, inc.lot) : i.amount.trim();
    if (!usdIn && !isMultiple(amount, inc.lot)) return { ok: false, describe: `Quantity must be a multiple of ${inc.lot} ${i.base} at this price` };
    const notional = Number(qty) * px;
    if (!(Number(qty) > 0) || notional < inc.minNotional) {
      return { ok: false, describe: usdIn ? `${usd(amount)} is below the smallest order at this price (${inc.lot} ${i.base}, min ${usd(inc.minNotional)})` : `The exchange's minimum order is ${usd(inc.minNotional)}` };
    }
    return { ok: true, qty: trim(qty), quoteQty: false, describe: usdIn ? `Sends ${trim(qty)} ${i.base} at ${px} = ${usd(notional)}` : `= ${usd(notional)}` };
  }

  // DeFi: buys are sized in USDC, sells in the asset. The exchange's increments don't apply; the only
  // limit is each token's on-chain precision (USDC has 6 decimals).
  const tokenDecimals = Math.min(i.defiDecimals ?? 8, MAX_FLOAT_DECIMALS);
  if (i.side === "BUY") {
    if (usdIn) {
      if (decimalsIn(i.amount) > USDC_DECIMALS) return { ok: false, describe: `USDC has at most ${USDC_DECIMALS} decimals` };
      const est = touch ? ` (≈ ${trim(floorTo(amount / touch, tokenDecimals))} ${i.base} at the CeFi ask)` : "";
      return { ok: true, qty: i.amount.trim(), quoteQty: true, describe: `Spends ${usd(amount)} USDC${est}` };
    }
    if (!touch) return { ok: false, describe: "No CeFi ask to price this; enter USD instead" };
    // Rounded up to USDC's precision, so the spend covers the quantity at the ask.
    const spend = trim(ceilTo(amount * touch, USDC_DECIMALS));
    return { ok: true, qty: spend, quoteQty: true, describe: `Spends ≈ ${usd(Number(spend))} USDC (${trim(String(amount))} × CeFi ask); the quote shows the exact amount` };
  }
  if (usdIn) {
    if (!touch) return { ok: false, describe: "No CeFi bid to price this; enter a quantity instead" };
    const qty = floorTo(amount / touch, tokenDecimals);
    if (!(Number(qty) > 0)) return { ok: false, describe: "Too small to sell" };
    return { ok: true, qty: trim(qty), quoteQty: false, describe: `Sells ≈ ${trim(qty)} ${i.base} (${usd(amount)} ÷ CeFi bid); the quote shows the exact amount` };
  }
  if (i.defiDecimals !== undefined && decimalsIn(i.amount) > i.defiDecimals) {
    return { ok: false, describe: `${i.base} has at most ${i.defiDecimals} decimals on chain` };
  }
  return { ok: true, qty: i.amount.trim(), quoteQty: false, describe: touch ? `≈ ${usd(amount * touch)} at the CeFi bid` : "" };
}

// Rounds down, so a quantity bought for a USD amount never costs more than it.
function floorTo(x: number, decimals: number): string {
  const f = 10 ** decimals;
  // The small epsilon keeps 0.3 / 0.1 from flooring to 2.
  return (Math.floor(x * f + 1e-9) / f).toFixed(decimals);
}

function ceilTo(x: number, decimals: number): string {
  const f = 10 ** decimals;
  return (Math.ceil(x * f - 1e-9) / f).toFixed(decimals);
}

function decimalsIn(s: string): number {
  const t = s.trim();
  return t.includes(".") ? t.split(".")[1]!.length : 0;
}

function trim(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

function usd(v: number): string {
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
