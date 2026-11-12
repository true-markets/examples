import { errorMessage } from "./tm/errors.ts";
import { priceHistory } from "./tm/gateway.ts";

export interface PriceQuote {
  price: string | null;
  as_of: string | null;
}

export interface PriceBook {
  get(symbol: string): PriceQuote;
}

const EMPTY: PriceQuote = { price: null, as_of: null };

const quotes = new Map<string, PriceQuote>();
const failing = new Set<string>();
let timer: ReturnType<typeof setInterval> | undefined;

async function refresh(symbol: string, fetchHistory: typeof priceHistory): Promise<void> {
  try {
    const last = (await fetchHistory(symbol)).points.at(-1);
    if (!last) throw new Error("no price points");
    quotes.set(symbol, { price: last.price, as_of: last.t });
    failing.delete(symbol);
  } catch (err) {
    if (failing.has(symbol)) return;
    failing.add(symbol);
    console.warn(`${symbol} price poll failed: ${errorMessage(err)}`);
  }
}

export function startPricePoller(symbols: readonly string[], intervalMs = 15_000, fetchHistory = priceHistory): void {
  const poll = () => Promise.allSettled(symbols.map((s) => refresh(s, fetchHistory)));
  void poll();
  timer = setInterval(() => void poll(), intervalMs);
}

export function stopPricePoller(): void {
  clearInterval(timer);
  timer = undefined;
  quotes.clear();
  failing.clear();
}

export const prices: PriceBook = {
  get: (symbol) => quotes.get(symbol) ?? EMPTY,
};
