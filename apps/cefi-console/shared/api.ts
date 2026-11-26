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
  // Set when QUOTER_URL points at a cefi-quoter; the header then shows the Quoter screen.
  quoter?: { url: string } | null;
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

// ---------- cefi-quoter management API (apps/cefi-quoter), passed through by this server ----------
// Decimals are strings, as everywhere else; plain numbers are numbers.

export interface QuoterParamSpec {
  key: string;
  label: string;
  type: "number" | "integer" | "decimal" | "choice" | "boolean";
  // A fixed unit (bps, ms, x), "quote" for the quote currency, or "size" for a size in whichever
  // unit sizeUnit chooses (the base asset or the quote currency).
  unit?: string;
  help: string;
  min?: number;
  max?: number;
  options?: string[]; // choice only
}

export type QuoterParams = Record<string, number | string | boolean>;

export interface QuoterParamsResponse {
  params: QuoterParams;
  schema: QuoterParamSpec[];
}

// The quoter-wide settings (not any one book's), with the same kind of schema as a book's parameters.
export interface QuoterSettingsResponse {
  settings: QuoterParams;
  schema: QuoterParamSpec[];
}

export interface QuoterConn {
  up: boolean;
  reason?: string;
  since: string;
}

export interface QuoterOrder {
  externalId: string;
  orderId?: string;
  side: "BUY" | "SELL";
  level: number;
  price: string;
  qty: string;
  leaves: string;
  executed: string;
  pendingPrice?: string;
  pendingQty?: string;
  status: "NEW_PENDING" | "ACTIVE" | "MODIFY_PENDING" | "CANCEL_PENDING";
  pendingMs?: number;
  take?: boolean; // an IOC crossing the spread (level -1), not a resting quote
}

export interface QuoterTarget {
  side: "BUY" | "SELL";
  level: number;
  price: string;
  qty: string;
}

export interface QuoterEvent {
  time: string;
  kind: "info" | "warn" | "fill" | "take" | "reject" | "param";
  message: string;
}

export interface QuoterMarket {
  symbol: string;
  instrumentId: string;
  baseAssetId: string;
  quoteAssetId: string;
  baseSymbol: string;
  quoteSymbol: string;
  reference: string; // the main source of fair value: a Coinbase product (BTC-USD), hyperliquid:xyz:GOOGL, kraken:GOOGLx/USD
  blend: QuoterBlend;
}

// A book's reference price: a weighted average of one or more sources, each lined up with a
// multiplier. See apps/cefi-quoter/reference/blend.go.
export interface QuoterSource {
  ref: string;
  weight: number; // 0 watches the source: checked against the others, not part of the price
  multiplier?: string; // turns the source's price into the price of one share; 1 if left out
}

export interface QuoterBlend {
  sources: QuoterSource[];
  weighting?: "fixed" | "depth";
  maxDeviationBps?: number; // a source further than this from the others is left out
  tokenMultiplier?: string; // shares per token of the book; 1 if left out
}

export interface QuoterCorporateAction {
  kind: "split" | "multiplier" | "drift";
  ratio: number;
  multiplier: string; // the source multiplier that would line it up
  text: string;
}

export interface QuoterSourceView {
  ref: string;
  name: string;
  weight: number;
  multiplier: string;
  bid: string | null;
  ask: string | null;
  mid: string | null;
  adjusted: string | null; // mid × multiplier
  spreadBps: number | null;
  depthUsd: string | null;
  ageMs: number | null;
  share: number; // of the blended price, 0 to 1
  gapBps: number | null; // against the other sources
  state: "in" | "watch" | "waiting" | "stale" | "out";
  note?: string;
  action?: QuoterCorporateAction;
}

export interface QuoterBlendView {
  sources: QuoterSourceView[];
  weighting: "fixed" | "depth";
  maxDeviationBps: number;
  tokenMultiplier: string;
  perShare: string | null;
  mid: string | null; // the book's fair value: per share × token multiplier
  bid: string | null;
  ask: string | null;
  used: number;
  problem?: string;
}

// POST /api/references/{symbol}/preview
export interface QuoterReferencePreview {
  symbol: string;
  blend: QuoterBlendView;
  bookBid: string | null;
  bookAsk: string | null;
  bookMid: string | null;
  bookGapBps: number | null;
  tokenMultiplier: string | null; // what would line the blend up with the book's own mid
  warnings: string[];
}

// GET /api/books/{symbol}: one book in full.
export interface QuoterStatus {
  market: QuoterMarket;
  enabled: boolean;
  state: "quoting" | "waiting" | "stopped";
  reason?: string;
  params: QuoterParams;
  reference: { mid: string; bid: string; ask: string; ageMs: number } | null;
  bestBid: string | null;
  bestAsk: string | null;
  mid: string | null;
  skewBps: number;
  // Since is when the position started counting (the book's first start, or its last reset); it
  // carries across quoter restarts.
  position: { qty: string; avgCost: string; realizedPnl: string; unrealizedPnl: string; volumeBase: string; volumeQuote: string; since: string };
  // Free is shared by every book on the asset; budget and held are this book's.
  balances: { freeBase: string; freeQuote: string; budgetBase: string; budgetQuote: string; heldBase: string; heldQuote: string; readAt: string | null };
  orders: QuoterOrder[];
  targets: QuoterTarget[];
  stats: {
    creates: number;
    modifies: number;
    cancels: number;
    rejects: number;
    errors: number;
    fills: number;
    takes: number;
    takeFills: number;
    // Requests refused for the exchange's rate limit, and how many of those paused every book.
    rateLimited?: number;
    rateLimitPauses?: number;
  };
  events: QuoterEvent[];
  warnings: string[];
  taking: QuoterTakeView | null;
  blend?: QuoterBlendView;
}

// How close one side is to a take. BUY takes the best ask; SELL hits the best bid.
export interface QuoterTakeSide {
  side: "BUY" | "SELL";
  kind: "profit take" | "takeout";
  enabled: boolean;
  price: string | null;
  qty: string; // shown there by other people
  edgeBps: number | null; // net, over the skewed mid
  thresholdBps: number;
  size: string; // what a take would send now
  blocker?: string; // why it isn't taking; absent means it would
}

export interface QuoterTakeView {
  buy: QuoterTakeSide;
  sell: QuoterTakeSide;
}

type QuoterStats = QuoterStatus["stats"];

// Every book on one quote currency, added up.
export interface QuoterTotals {
  quote: string;
  books: number;
  quoting: number;
  realizedPnl: string;
  unrealizedPnl: string;
  volumeQuote: string;
  orders: number;
  stats: QuoterStats;
}

// One fill, with its edge at the time and mark-outs later (bps in our favor; null until due).
export interface QuoterTrade {
  id: number;
  time: string;
  symbol: string;
  quote: string;
  side: "BUY" | "SELL";
  kind: string; // maker, profit take or takeout
  level: number;
  qty: string;
  price: string;
  notional: string;
  refMid: string;
  edgeBps: number;
  markouts: (number | null)[];
  recovered?: boolean; // filled while the quoter was down: no fair value, left out of the averages
  unpriced?: boolean; // filled while the book had no reference price: the same
}

export interface QuoterTradeSummary {
  symbol: string; // "" for every book
  trades: number;
  notional: string;
  edgeBps: number | null;
  edgePnl: number | null; // edge at fill in quote currency, summed
  markouts: (number | null)[];
  retention: (number | null)[];
  marked: number[];
  markedPnl: (number | null)[];
  byKind: Record<string, number>;
  horizonsSecs: number[];
}

// A request the exchange refused, or that failed to send.
export interface QuoterReject {
  time: string;
  book: string;
  request?: "create" | "modify" | "cancel";
  side?: "BUY" | "SELL";
  level?: string; // L0, L1, ... or take
  price?: string;
  qty?: string;
  reason: string;
  via: string; // drop copy, FIX cancel reject, or send
}

export interface QuoterTradesReport {
  trades: QuoterTrade[];
  total: QuoterTradeSummary;
  byBook: QuoterTradeSummary[];
  horizonsSecs: number[];
}

// One line per book in the desk status.
export interface QuoterBookSummary {
  market: QuoterMarket;
  enabled: boolean;
  state: QuoterStatus["state"];
  reason?: string;
  reference: string | null;
  position: string;
  // What the open PnL is made of: (reference − avgCost) × position, counting the book's own fills
  // since positionSince. Older quoters don't send these.
  avgCost?: string;
  positionSince?: string;
  realizedPnl: string;
  unrealizedPnl: string;
  orders: number;
  fills: number;
  heldBase: string;
  heldQuote: string;
  budgetBase: string;
  budgetQuote: string;
  maxQuoteAlloc: string;
  maxBaseAlloc: string;
  volumeQuote: string;
  stats: QuoterStats;
}

// One asset in the ledger every book shares: free = spendable - foreign holds - our holds.
export interface QuoterAssetBalance {
  assetId: string;
  symbol: string;
  spendable: string;
  foreignHold: string;
  ourHold: string;
  free: string;
  price: string | null; // one unit in the quote currency: 1 for USDC, a book's reference mid otherwise
}

export interface QuoterListing {
  symbol: string;
  instrumentId: string;
  baseSymbol: string;
  quoteSymbol: string;
  reference: string;
  underlying?: string;
  stock?: boolean;
}

// GET /api/status: the whole quoter process.
export interface QuoterDeskStatus {
  mode: "live" | "paper";
  // The client order id prefix on every order the quoter places. Older quoters don't send it.
  idPrefix?: string;
  environment: "production" | "uat" | "paper";
  transport: "rest" | "fix" | "paper";
  clientId: string;
  startedAt: string;
  connections: Partial<Record<"dropcopy" | "market" | "reference" | "orders", QuoterConn>>;
  balances: QuoterAssetBalance[];
  balancesReadAt: string | null;
  books: QuoterBookSummary[];
  available: QuoterListing[];
  warnings: string[];
  totals: QuoterTotals[];
  trades: QuoterTradeSummary;
  // The request pacer every book shares. Older quoters don't send it.
  // used / usedMin: new orders and modifies in the last second / minute; peak: the most in any second over the last minute.
  rateLimit?: { perSec: number; perMin?: number; used?: number; usedMin?: number; peak?: number; pausedForMs: number; lastAt: string | null };
}
