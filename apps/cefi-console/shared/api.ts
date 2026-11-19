// What this app's server returns to the browser under /api. The server reshapes the True Markets
// responses into these so the UI has one order shape whether a row came from REST or DROPCOPY.

import type { OrderEvent, OrderStatus, OrderType, Side, TimeInForce } from "./wire.ts";

export type Mode = "live" | "demo";

export interface Session {
  mode: Mode;
  environment: "production" | "uat" | "demo";
  clientId: string | null;
  // What to call the account in the header: TM_ACCOUNT_LABEL if set, else the email in the token's
  // sub claim, else the CeFi client's mnemonic (unless it is an opaque hash), else null.
  accountLabel: string | null;
  // Why something is missing, in plain words, so the UI can say it instead of failing quietly.
  warnings: string[];
}

export interface Instrument {
  id: string;
  symbol: string;
  status: string;
  baseAssetId?: string;
  quoteAssetId?: string;
  referencePrice?: string;
  priceBandsPercent?: string;
  notional24h?: string;
  quantity24h?: string;
  // The DeFi listing of the same asset, when there is one. DeFi takes market orders only.
  // decimals is the token's on-chain precision, the only limit on a DeFi quantity.
  defi?: { assetId: string; chain: string | null; symbol: string; decimals?: number };
}

// A DeFi market order goes through the gateway: it is quoted first, then signed and executed.
export interface DefiOrderInput {
  symbol: string;
  side: "BUY" | "SELL";
  // A buy spends this much USDC; a sell sells this much of the asset.
  qty: string;
}

export interface DefiQuote {
  orderId: string;
  side: "BUY" | "SELL";
  symbol: string;
  chain: string | null;
  // What goes in and what is expected to come out, after fees, in the asset names the gateway uses.
  qtyIn: string;
  assetIn: string;
  qtyOut: string;
  assetOut: string;
  fee: string;
  feeAsset: string;
  issues: string[];
  // False when the quote can't be executed, e.g. "Insufficient balance".
  executable: boolean;
  // When the server stops accepting execute for this quote (ms since epoch).
  expiresAt: number;
}

export interface DefiOrderState {
  orderId: string;
  status: "initialized" | "pending" | "cancel_pending" | "complete" | "canceled" | "active" | "failed";
  side?: "BUY" | "SELL";
  symbol?: string;
  chain?: string | null;
  executedQty?: string;
  executedVwap?: string;
  fee?: string;
  txHash?: string;
  explorerUrl?: string;
  failureReason?: string;
}

export function isDefiDone(s: DefiOrderState["status"]): boolean {
  return s === "complete" || s === "failed" || s === "canceled";
}

export interface OrderRow {
  orderId: string;
  externalId?: string;
  instrumentId?: string;
  symbol: string;
  side: Side;
  type: OrderType;
  tif: TimeInForce;
  status: OrderStatus;
  price?: string;
  qty: string;
  leavesQty: string;
  executedQty: string;
  vwap?: string;
  // Nanosecond timestamps as strings; createdNs is the earliest time this app has seen the order.
  createdNs: string;
  updatedNs: string;
  lastEvent?: OrderEvent;
  text?: string;
}

export interface FillRow {
  // match_id plus order_id: one match fills two orders, and both may be yours.
  id: string;
  orderId: string;
  symbol: string;
  side: Side;
  price: string;
  qty: string;
  feeBps?: string;
  liquidity?: "TAKER" | "MAKER" | "SETTER";
  timestampNs: string;
}

export interface NewOrderInput {
  symbol: string;
  side: Side;
  type: "LIMIT" | "MARKET";
  tif: TimeInForce;
  qty: string;
  price?: string;
  postOnly?: boolean;
  // MARKET only: qty is an amount of the quote asset (USDC), converted by the exchange at entry
  // (the QUOTE_QTY flag). A buy never spends more than qty.
  quoteQty?: boolean;
  externalId?: string;
}

export interface ModifyOrderInput {
  qty: string;
  price: string;
}

export interface CancelResult {
  accepted: string[];
  failed: { orderId: string; error: string }[];
}

// One asset in the wallet with what part of it is committed to CeFi.
export interface WalletBalance {
  assetId: string;
  economicAssetId?: string;
  symbol: string;
  name?: string;
  chain: string | null;
  // In the wallet and not allocated: total net of allocated, as GET /balances reports it.
  total: string;
  // Of that, what is free to use (not held by a transfer).
  available: string;
  held: string;
  // Committed to CeFi trading. The tokens stay in the wallet but can't leave until released.
  allocated: string;
  stable: boolean;
  // The token's on-chain precision; an amount can't be finer than this.
  decimals?: number;
}

// One asset on the exchange, from GET /v1/cefi/balances.
export interface CefiBalance {
  assetId: string;
  symbol: string;
  balance: string;
  unsettled: string;
  orderHold: string;
  transferHold: string;
  // balance + unsettled - order_hold - transfer_hold (and the fee holds for the fee asset).
  tradable: string;
  state: string;
}

export interface AssetPrice {
  // USD per unit; null when the asset has no live price.
  price: number | null;
  // Everything held of the asset, in USD: wallet plus CeFi, with allocated funds counted once.
  valueUsd: number | null;
}

export interface Balances {
  // By asset symbol, from GET /v1/gateway/portfolio. Empty when it could not be read.
  prices: Record<string, AssetPrice>;
  wallet: WalletBalance[];
  cefi: CefiBalance[];
  feesHold: string;
  unsettledFees: string;
  // Symbols that trade on CeFi; only these can be allocated.
  cefiSymbols: string[];
}

export type AllocationStatus = "allocating" | "crediting" | "releasing" | "completed" | "rejected" | "stranded";
export type ReleaseStatus = "debiting" | "completed" | "rejected" | "stranded";

export interface CustodyMove {
  id: string;
  kind: "allocation" | "release";
  status: AllocationStatus | ReleaseStatus;
  assetId: string;
  symbol: string;
  amount: string;
  allocatedTotal?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  // The exchange's own transfer behind this move. It usually finishes in well under a second, while
  // the gateway can take 20 s or more to mark the move completed.
  exchange?: { transferId: string; status: string; doneAt?: string };
}

export function isCustodyPending(move: CustodyMove): boolean {
  return !["completed", "rejected", "stranded"].includes(move.status);
}

// Done on the exchange: the funds are already tradable (allocation) or free (release), even if the
// gateway hasn't caught up yet.
export function isCustodySettled(move: CustodyMove): boolean {
  return !isCustodyPending(move) || move.exchange?.status === "COMPLETED";
}

export interface ApiError {
  error: string;
  status?: number;
}
