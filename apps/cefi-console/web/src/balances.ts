import type { Balances, CefiBalance, WalletBalance } from "../../shared/api.ts";

// One row per asset, across every chain it sits on and CeFi.
export interface AssetRow {
  symbol: string;
  price: number | null;
  valueUsd: number | null;
  // Everything in the wallet, allocated or not.
  wallet: number;
  // Of the wallet, what is committed to CeFi trading.
  allocated: number;
  allocatedPct: number | null;
  cefi?: CefiBalance;
  wallets: WalletBalance[];
  canAllocate: boolean;
}

export function toRows(data: Balances | undefined): AssetRow[] {
  if (!data) return [];
  const by = new Map<string, AssetRow>();
  const get = (symbol: string): AssetRow => {
    let r = by.get(symbol);
    if (!r) {
      const p = data.prices[symbol];
      r = {
        symbol,
        price: p?.price ?? null,
        valueUsd: p?.valueUsd ?? null,
        wallet: 0,
        allocated: 0,
        allocatedPct: null,
        wallets: [],
        canAllocate: data.cefiSymbols.includes(symbol),
      };
      by.set(symbol, r);
    }
    return r;
  };
  for (const w of data.wallet) {
    const r = get(w.symbol);
    r.wallets.push(w);
    // GET /balances reports a wallet's total net of what is allocated, so add it back.
    r.wallet += Number(w.total) + Number(w.allocated);
    r.allocated += Number(w.allocated);
  }
  for (const c of data.cefi) get(c.symbol).cefi = c;
  for (const r of by.values()) r.allocatedPct = r.wallet > 0 ? r.allocated / r.wallet : null;
  return [...by.values()];
}

export type AmountUnit = "USD" | "QTY";

export type CustodyAmount =
  | { ok: true; qty: string; usdValue: number | null; describe: string }
  | { ok: false; describe: string };

// What an allocate or release amount means, typed in USD or as a quantity. Allocations and
// releases are always sent as a quantity, so USD is converted at the price and rounded down to the
// token's decimals, never past what is available.
export function custodyAmount(a: { unit: AmountUnit; input: string; price: number | null; decimals: number; max: number; symbol: string }): CustodyAmount {
  const text = a.input.trim().replace(/^\./, "0.");
  const n = Number(text);
  if (!text || !(n > 0) || !/^\d+(\.\d+)?$/.test(text)) return { ok: false, describe: "" };
  const d = Math.min(a.decimals, 12);
  let qty: string;
  if (a.unit === "USD") {
    if (a.price === null || !(a.price > 0)) return { ok: false, describe: `${a.symbol} has no price; enter a quantity` };
    qty = trimZeros(floorDecimals(n / a.price, d));
    if (!(Number(qty) > 0)) return { ok: false, describe: `Too small: less than one unit of ${a.symbol} at ${d} decimals` };
  } else {
    const places = text.includes(".") ? text.split(".")[1]!.length : 0;
    if (places > a.decimals) return { ok: false, describe: `${a.symbol} has at most ${a.decimals} decimals` };
    qty = text;
  }
  const usdValue = a.price !== null ? Number(qty) * a.price : null;
  if (Number(qty) > a.max + 1e-12) return { ok: false, describe: `More than the ${trimZeros(a.max.toFixed(d))} ${a.symbol} available` };
  const describe =
    a.unit === "USD"
      ? `= ${qty} ${a.symbol}`
      : usdValue !== null
        ? `≈ ${usdValue.toLocaleString(undefined, { style: "currency", currency: "USD" })}`
        : "";
  return { ok: true, qty, usdValue, describe };
}

export function floorDecimals(x: number, d: number): string {
  const f = 10 ** d;
  return (Math.floor(x * f + 1e-9) / f).toFixed(d);
}

export function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

// The book to open for an asset: a listed instrument with it as the base, quoted in USDC if there's
// one. None for an asset that's only ever the quote, like USDC itself.
export function bookFor(asset: string, symbols: string[]): string | undefined {
  const mine = symbols.filter((s) => s.split("-")[0] === asset);
  return mine.find((s) => s.endsWith("-USDC")) ?? mine[0];
}
