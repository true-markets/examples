import { useQuery } from "@tanstack/react-query";
import type { AssetRow, HouseholdDetail, HouseholdsResponse, Me, TradeDetail, TradeStatus } from "./types.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface Envelope {
  code?: string;
  message?: string;
}

export async function api<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }).catch(() => {
    throw new ApiError(0, "Kumi's server is not reachable.");
  });
  if (res.status === 204) return undefined as T;

  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const envelope = (data ?? {}) as Envelope;
    throw new ApiError(res.status, envelope.message ?? `request failed with status ${res.status}`, envelope.code);
  }
  return data as T;
}

export function isUnreachable(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 0 || err.status === 502 || err.status === 504);
}

const TERMINAL: readonly TradeStatus[] = ["complete", "stopped"];

export function isTerminal(status: TradeStatus): boolean {
  return TERMINAL.includes(status);
}

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/me") });
}

export function useAssets() {
  return useQuery({ queryKey: ["assets"], queryFn: () => api<AssetRow[]>("/api/assets"), refetchInterval: 15_000 });
}

export function useHouseholds() {
  return useQuery({
    queryKey: ["households"],
    queryFn: () => api<HouseholdsResponse>("/api/households"),
    refetchInterval: (q) => ((q.state.data?.active_trades.length ?? 0) > 0 ? 1_000 : 15_000),
  });
}

export function useHousehold(id: string) {
  return useQuery({
    queryKey: ["household", id],
    queryFn: () => api<HouseholdDetail>(`/api/households/${encodeURIComponent(id)}`),
    refetchInterval: (q) => {
      const last = q.state.data?.last_trade;
      return last && !isTerminal(last.status) ? 1_000 : 15_000;
    },
  });
}

export function useTrade(id: string) {
  return useQuery({
    queryKey: ["trade", id],
    queryFn: () => api<TradeDetail>(`/api/trades/${encodeURIComponent(id)}`),
    refetchInterval: (q) => (q.state.data && isTerminal(q.state.data.status) ? false : 1_000),
  });
}
