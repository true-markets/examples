import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  Session,
} from "../../shared/api.ts";
import { isCustodyPending, isCustodySettled, isDefiDone } from "../../shared/api.ts";
import { usd as usdText } from "./format.ts";
import { store } from "./store.ts";
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
export const useCancelAll = () =>
  useAction((symbol: string | undefined) => call<CancelResult>("POST", "/api/orders/cancel-all", { symbol }), {
    success: (r, symbol) => cancelSummary(r, symbol ? `in ${symbol}` : "everywhere"),
  });

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
