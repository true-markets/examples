import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  Balances,
  CancelResult,
  CustodyMove,
  DefiOrderInput,
  DefiOrderState,
  DefiQuote,
  FillRow,
  Instrument,
  ModifyOrderInput,
  NewOrderInput,
  OrderRow,
  QuoterBlend,
  QuoterDeskStatus,
  QuoterParams,
  QuoterParamsResponse,
  QuoterReferencePreview,
  QuoterSource,
  QuoterStatus,
  QuoterReject,
  QuoterTradesReport,
  Session,
} from "../../shared/api.ts";
import { isCustodyPending, isCustodySettled, isDefiDone } from "../../shared/api.ts";
import type { QuoterOwned } from "../../shared/orders.ts";
import { usd as usdText } from "./format.ts";
import { isLive, store } from "./store.ts";
import { toast } from "./toast.ts";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new HttpError(data.error ?? `${method} ${path} failed (${res.status})`, res.status);
  return data;
}

// ---------- reads ----------

export const useSession = () => useQuery({ queryKey: ["session"], queryFn: () => call<Session>("GET", "/api/session"), staleTime: Infinity });

// Disabled (or unknown) instruments can't trade, so they get no tile or market-data subscription.
export function isListed(i: Instrument): boolean {
  return i.status !== "DISABLED" && i.status !== "INVALID";
}

export const useInstruments = () =>
  useQuery({ queryKey: ["instruments"], queryFn: () => call<Instrument[]>("GET", "/api/instruments"), staleTime: 60_000, refetchInterval: 60_000 });

// The REST order list seeds the store; DROPCOPY keeps it current from then on.
export function useOrderHistory() {
  const q = useQuery({ queryKey: ["orders"], queryFn: () => call<OrderRow[]>("GET", "/api/orders"), refetchOnWindowFocus: false });
  useEffect(() => {
    if (q.data) store.seedOrders(q.data);
  }, [q.data]);
  return q;
}

export function useFillHistory() {
  const q = useQuery({ queryKey: ["fills"], queryFn: () => call<FillRow[]>("GET", "/api/fills"), refetchOnWindowFocus: false });
  useEffect(() => {
    if (q.data) store.seedFills(q.data);
  }, [q.data]);
  return q;
}

// Fills that stream in (DROPCOPY) have no liquidity flag or fee; REST does. Shortly after fills
// arrive, read the newest page of REST fills to replace them, and try again a few times if REST
// hasn't caught up. One CeFi call per burst of fills, outside the gateway's rate limit.
export function useFillEnrichment() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const run = async () => {
      const rows = await call<FillRow[]>("GET", "/api/fills?recent=1").catch(() => undefined);
      if (rows) store.mergeFills(rows);
      const waiting = store.fills.some((f) => isLive(f) && Date.now() - Number(f.timestampNs.slice(0, -6)) < 60_000);
      if (waiting && tries < 3) {
        tries++;
        timer = setTimeout(run, 5_000);
      }
    };
    store.onLiveFill = () => {
      clearTimeout(timer);
      tries = 0;
      timer = setTimeout(run, 2_000);
    };
    return () => {
      clearTimeout(timer);
      store.onLiveFill = () => {};
    };
  }, []);
}

export const useBalances = () =>
  useQuery({ queryKey: ["balances"], queryFn: () => call<Balances>("GET", "/api/balances"), refetchInterval: 10_000 });

// Polls every second while an allocation or release is moving, every 30 otherwise. This only reaches
// this app's server: it follows the exchange's own transfer at most once a second and asks the
// gateway at most every 3 seconds, so the gateway's 100-a-minute limit is safe. Balances are read
// again the moment a move settles on the exchange, without waiting for the gateway to confirm.
export function useCustody() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["custody"],
    queryFn: () => call<CustodyMove[]>("GET", "/api/custody"),
    refetchInterval: (q) => (q.state.data?.some(isCustodyPending) ? 1_000 : 30_000),
  });
  const pending = q.data?.filter((m) => !isCustodySettled(m)).map((m) => m.id).join(",") ?? "";
  const [prev, setPrev] = useState(pending);
  if (prev !== pending) {
    setPrev(pending);
    if (prev.split(",").some((id) => id && !pending.includes(id))) void qc.invalidateQueries({ queryKey: ["balances"] });
  }
  return q;
}

export const useDemoStrategy = (enabled: boolean) =>
  useQuery({ queryKey: ["demo-strategy"], queryFn: () => call<{ running: boolean }>("GET", "/api/demo/strategy"), enabled });

// ---------- actions ----------

function useAction<I, O>(fn: (input: I) => Promise<O>, opts: { success?: (o: O, i: I) => string | undefined; invalidate?: string[] } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (out, input) => {
      const msg = opts.success?.(out, input);
      if (msg) toast.ok(msg);
      for (const key of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (err) => toast.error(err.message),
  });
}

export const usePlaceOrder = () =>
  useAction((input: NewOrderInput) => call<{ orderId: string }>("POST", "/api/orders", input), {
    // A USD-sized market order says so, so "100" doesn't read as 100 shares.
    success: (_o, i) => (i.quoteQty ? `${i.side} ${usdText(Number(i.qty))} of ${i.symbol} at market sent` : `${i.side} ${i.qty} ${i.symbol} sent`),
  });

export const useModifyOrder = () =>
  useAction(({ orderId, ...input }: ModifyOrderInput & { orderId: string }) => call("PATCH", `/api/orders/${orderId}`, input), {
    success: () => "Modify sent",
  });

export const useCancelOrder = () => useAction((orderId: string) => call("DELETE", `/api/orders/${orderId}`));

function cancelSummary(r: CancelResult, what: string): string {
  const failed = r.failed.length ? `, ${r.failed.length} failed` : "";
  return r.accepted.length === 0 && !r.failed.length ? `No open orders ${what}` : `Cancel sent for ${r.accepted.length} order${r.accepted.length === 1 ? "" : "s"} ${what}${failed}`;
}

// Cancels many orders: everything (symbol undefined), or one symbol's orders.
// keepQuoter leaves the orders a running quoter keeps resting (see isQuoterOwned).
export const useCancelAll = () =>
  useAction(
    ({ symbol, keepQuoter }: { symbol?: string; keepQuoter?: QuoterOwned }) =>
      call<CancelResult>("POST", "/api/orders/cancel-all", { symbol, keepQuoter }),
    { success: (r, { symbol }) => cancelSummary(r, symbol ? `in ${symbol}` : "everywhere") },
  );

// Cancels a hand-picked set, one request per order.
export const useCancelMany = () =>
  useAction(
    async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => call("DELETE", `/api/orders/${id}`)));
      const failed = results.flatMap((r, i) => (r.status === "rejected" ? [{ orderId: ids[i]!, error: String(r.reason) }] : []));
      return { accepted: ids.filter((_, i) => results[i]?.status === "fulfilled"), failed } satisfies CancelResult;
    },
    { success: (r) => cancelSummary(r, "selected") },
  );

export const useCustodyMove = () =>
  useAction(
    ({ kind, assetId, amount }: { kind: "allocations" | "releases"; assetId: string; amount: string; symbol: string }) =>
      call<CustodyMove>("POST", `/api/custody/${kind}`, { assetId, amount }),
    {
      success: (_m, i) => `${i.kind === "allocations" ? "Allocating" : "Releasing"} ${i.amount} ${i.symbol}`,
      invalidate: ["custody", "balances"],
    },
  );

export const useSetDemoStrategy = () =>
  useAction((running: boolean) => call<{ running: boolean }>("POST", "/api/demo/strategy", { running }), {
    success: (r) => (r.running ? "Simulated strategy resumed" : "Simulated strategy paused"),
    invalidate: ["demo-strategy"],
  });

// ---------- DeFi market orders ----------

// Asks the gateway for a quote. Nothing trades yet, but creating the order can free funds allocated
// to CeFi to pay for it.
export const useDefiQuote = () =>
  useMutation({
    mutationFn: (input: DefiOrderInput) => call<DefiQuote>("POST", "/api/defi/quote", input),
    onError: (err) => toast.error(err.message),
  });

export const useDefiExecute = () =>
  useAction((orderId: string) => call<DefiOrderState>("POST", `/api/defi/${orderId}/execute`), {
    success: () => "DeFi order sent",
    invalidate: ["balances"],
  });

// Follows a DeFi order until it completes or fails, then refreshes balances once.
export function useDefiOrder(orderId: string | undefined) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["defi-order", orderId],
    queryFn: () => call<DefiOrderState>("GET", `/api/defi/${orderId}`),
    enabled: !!orderId,
    refetchInterval: (q) => (q.state.data && isDefiDone(q.state.data.status) ? false : 1_500),
  });
  const done = q.data && isDefiDone(q.data.status);
  useEffect(() => {
    if (done) void qc.invalidateQueries({ queryKey: ["balances"] });
  }, [done, qc]);
  return q;
}

// ---------- cefi-quoter ----------

// Once a second while the Quoter screen is open. Each read is one local HTTP call to the quoter; it
// never reaches True Markets.
export const useQuoterStatus = (enabled: boolean) =>
  useQuery({
    queryKey: ["quoter-status"],
    queryFn: () => call<QuoterDeskStatus>("GET", "/api/quoter/status"),
    enabled,
    refetchInterval: 1_000,
    retry: false,
  });

export const useQuoterRejects = (enabled: boolean) =>
  useQuery({
    queryKey: ["quoter-rejects"],
    queryFn: () => call<{ rejects: QuoterReject[] }>("GET", "/api/quoter/rejects?limit=1000"),
    enabled,
    refetchInterval: 2_000,
    retry: false,
  });

export const useQuoterTrades = (enabled: boolean) =>
  useQuery({
    queryKey: ["quoter-trades"],
    queryFn: () => call<QuoterTradesReport>("GET", "/api/quoter/trades?limit=500"),
    enabled,
    refetchInterval: 2_000,
    retry: false,
  });

const bookPath = (symbol: string) => `/api/quoter/books/${encodeURIComponent(symbol)}`;

export const useQuoterBook = (symbol: string | undefined) =>
  useQuery({
    queryKey: ["quoter-book", symbol],
    queryFn: () => call<QuoterStatus>("GET", bookPath(symbol!)),
    enabled: !!symbol,
    refetchInterval: 1_000,
    retry: false,
  });

export const useQuoterParams = (symbol: string | undefined) =>
  useQuery({ queryKey: ["quoter-params", symbol], queryFn: () => call<QuoterParamsResponse>("GET", `${bookPath(symbol!)}/params`), enabled: !!symbol, retry: false });

export const useUpdateQuoterParams = () =>
  useAction(({ symbol, patch }: { symbol: string; patch: QuoterParams }) => call<{ params: QuoterParams }>("PATCH", `${bookPath(symbol)}/params`, patch), {
    success: (_r, { symbol, patch }) => `${symbol}: set ${Object.keys(patch).join(", ")}`,
    invalidate: ["quoter-params", "quoter-book", "quoter-status"],
  });

// Every book's parameters at once, for the all-books editor. Shares the cache with each book's own
// Parameters panel.
export const useAllQuoterParams = (symbols: string[], enabled: boolean) =>
  useQueries({
    queries: symbols.map((symbol) => ({
      queryKey: ["quoter-params", symbol],
      queryFn: () => call<QuoterParamsResponse>("GET", `${bookPath(symbol)}/params`),
      enabled,
      retry: false,
    })),
  });

// Patches several books, one after another. Each book takes its own patch or rejects it; one
// rejection doesn't stop the rest. Resolves with what happened to each.
export interface BulkParamsResult {
  symbol: string;
  error?: string;
}
export function useBulkUpdateQuoterParams() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patches: { symbol: string; patch: QuoterParams }[]) => {
      const out: BulkParamsResult[] = [];
      for (const { symbol, patch } of patches) {
        try {
          await call("PATCH", `${bookPath(symbol)}/params`, patch);
          out.push({ symbol });
        } catch (err) {
          out.push({ symbol, error: (err as Error).message });
        }
      }
      return out;
    },
    onSettled: () => {
      for (const key of ["quoter-params", "quoter-book", "quoter-status"]) void qc.invalidateQueries({ queryKey: [key] });
    },
    onSuccess: (out) => {
      const ok = out.filter((r) => !r.error).length;
      const failed = out.filter((r) => r.error);
      if (ok) toast.ok(`Parameters set on ${ok} book${ok === 1 ? "" : "s"}`);
      for (const f of failed) toast.error(`${f.symbol}: ${f.error}`);
    },
    onError: (err) => toast.error(err.message),
  });
}

// Start or stop one book, or every book when symbol is left out.
export const useQuoterControl = () =>
  useAction(
    ({ action, symbol }: { action: "start" | "stop"; symbol?: string }) =>
      call<{ enabled: boolean }>("POST", symbol ? `${bookPath(symbol)}/${action}` : `/api/quoter/${action}`),
    {
      success: (r, { symbol }) => `${symbol ?? "Every book"}: ${r.enabled ? "quoting started" : "stopped; pulling quotes"}`,
      invalidate: ["quoter-status", "quoter-book"],
    },
  );

export const useResetQuoterPosition = () =>
  useAction((symbol: string) => call("POST", `${bookPath(symbol)}/reset`), {
    success: (_r, symbol) => `${symbol}: position, PnL and counts reset`,
    invalidate: ["quoter-book", "quoter-status"],
  });

// Start one book's reject, error and rate-limit counts from zero, or every book's.
export const useResetQuoterRejects = () =>
  useAction((symbol?: string) => call("POST", symbol ? `${bookPath(symbol)}/reset-rejects` : "/api/quoter/reset-rejects"), {
    success: (_r, symbol) => `${symbol ?? "Every book"}: reject counts reset`,
    invalidate: ["quoter-book", "quoter-status", "quoter-rejects"],
  });

export const useAddQuoterBook = () =>
  useAction((input: { symbol: string; reference?: string; blend?: QuoterBlend }) => call<{ market: { symbol: string } }>("POST", "/api/quoter/books", input), {
    success: (r) => `${r.market.symbol} added, stopped`,
    invalidate: ["quoter-status"],
  });

// The reference sources the quoter finds for a book (perps, tokenized stocks, spot), for setup.
export const useQuoterSuggest = (symbol: string | undefined) =>
  useQuery({
    queryKey: ["quoter-suggest", symbol],
    queryFn: () => call<{ sources: QuoterSource[] }>("GET", `/api/quoter/references/${encodeURIComponent(symbol!)}/suggest`),
    enabled: !!symbol,
    staleTime: 5 * 60_000,
    retry: false,
  });

// A blend evaluated against live prices every two seconds while it's being set up; nothing saved.
export const useQuoterPreview = (symbol: string | undefined, blend: QuoterBlend | undefined) =>
  useQuery({
    queryKey: ["quoter-preview", symbol, blend],
    queryFn: () => call<QuoterReferencePreview>("POST", `/api/quoter/references/${encodeURIComponent(symbol!)}/preview`, blend),
    enabled: !!symbol && !!blend && blend.sources.length > 0,
    refetchInterval: 2_000,
    placeholderData: (prev) => prev,
    retry: false,
  });

export const useSetQuoterReference = () =>
  useAction(({ symbol, blend }: { symbol: string; blend: QuoterBlend }) => call<{ market: { symbol: string } }>("PUT", `${bookPath(symbol)}/reference`, blend), {
    success: (r) => `${r.market.symbol}: reference updated`,
    invalidate: ["quoter-book", "quoter-status"],
  });

export const useRemoveQuoterBook = () =>
  useAction((symbol: string) => call("DELETE", bookPath(symbol)), {
    success: (_r, symbol) => `${symbol} removed`,
    invalidate: ["quoter-status"],
  });
