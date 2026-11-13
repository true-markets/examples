import type { Fee, HouseholdSummary, Side, TradeStatus, TradeSummary } from "./types.ts";

export const DASH = "–";

export function sanitizeDecimal(input: string): string {
  return input.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
}

function finite(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function usd(value: string | number | null | undefined): string {
  const n = finite(value);
  if (n === null) return DASH;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// A unit price keeps enough digits to read a cheap token: $84.86, $0.2593, $0.00001873.
export function unitPrice(value: number | string | null | undefined): string {
  const n = finite(value);
  if (n === null) return DASH;
  const abs = Math.abs(n);
  const digits = abs !== 0 && abs < 1 ? Math.min(10, Math.max(3, 2 - Math.floor(Math.log10(abs)) + 1)) : 2;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: digits });
}

// "$10" for a round amount, "$10.50" otherwise, as in "Buy $10 of Solana".
export function usdShort(value: string): string {
  const n = Number(value);
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function tokenAmount(value: string | number, symbol: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value} ${symbol}`;
  const max = n !== 0 && Math.abs(n) < 0.01 ? 6 : symbol === "USDC" ? 2 : 4;
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: max })} ${symbol}`;
}

// A zero amount reads as a dash, so empty cells stay quiet.
export function quantity(value: string | number | null | undefined, symbol: string): string {
  if (value === null || value === undefined || Number(value) === 0) return DASH;
  return tokenAmount(value, symbol);
}

// What the fees were worth, priced with the order's own average price. Null when a fee is in an asset that price can't value.
export function feesUsd(fees: readonly Fee[], tradedAsset: string, averagePrice: string): number | null {
  let total = 0;
  for (const fee of fees) {
    if (fee.asset === "USDC") total += Number(fee.amount);
    else if (fee.asset === tradedAsset) total += Number(fee.amount) * Number(averagePrice);
    else return null;
  }
  return total;
}

export function approxUsd(value: number | null): string {
  if (value === null) return DASH;
  if (value === 0) return "$0.00";
  return value < 0.005 ? "Under $0.01" : `≈ ${usd(value)}`;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

export function monthYear(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function stamp(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toDateString() === new Date(now).toDateString() ? `Today, ${time}` : `${shortDate(iso)}, ${time}`;
}

export function statusWord(status: TradeStatus): string {
  return {
    funding: "Funding the trading wallet",
    buying: "Buying",
    selling: "Selling",
    returning: "Returning to the client wallet",
    complete: "Complete",
    stopped: "Stopped",
  }[status];
}

export function statusTone(status: TradeStatus): "motion" | "ink" | "error" {
  if (status === "complete") return "ink";
  if (status === "stopped") return "error";
  return "motion";
}

export function assetName(symbol: string): string {
  return symbol === "SOL" ? "Solana" : symbol;
}

export function tradeTitle(trade: Pick<TradeSummary, "side" | "asset" | "status" | "usd" | "qty" | "received">): string {
  const done = trade.status === "complete" && trade.received !== undefined;
  if (trade.side === "buy") {
    return done ? `Bought ${tokenAmount(trade.received!, trade.asset)} for ${usd(trade.usd)}` : `Buy ${usdShort(trade.usd!)} of ${assetName(trade.asset)}`;
  }
  return done ? `Sold ${tokenAmount(trade.qty!, trade.asset)} for ${tokenAmount(trade.received!, "USDC")}` : `Sell ${tokenAmount(trade.qty!, trade.asset)}`;
}

export function lastActivity(household: HouseholdSummary): string {
  if (!household.ready) return "Setup not finished";
  const last = household.last_trade;
  if (!last) return `Added ${monthYear(household.created_at)}`;
  if (last.status === "complete") return `${tradeTitle(last)} · ${shortDate(last.created_at)}`;
  return statusWord(last.status);
}

export function feesLine(fees: readonly Fee[]): string {
  return fees.length === 0 ? "None" : fees.map((f) => tokenAmount(f.amount, f.asset)).join(" + ");
}

function heldValue(holding: { value_usd: string | null } | null): number | null {
  return holding ? finite(holding.value_usd) : null;
}

// Both wallets together, or null while the client wallet is unpriced.
export function totalValue(safekeeping: { value_usd: string | null }, trading: { value_usd: string | null } | null): number | null {
  const safe = heldValue(safekeeping);
  return safe === null ? null : safe + (heldValue(trading) ?? 0);
}

// What comes back to the client wallet: the token after a buy, USDC after a sell.
export function returnedAsset(side: Side, asset: string): string {
  return side === "buy" ? asset : "USDC";
}
