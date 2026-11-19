import { randomUUID } from "node:crypto";
import type {
  DefiOrderInput,
  DefiOrderState,
  DefiQuote,
  Balances,
  CancelResult,
  CustodyMove,
  FillRow,
  Instrument,
  ModifyOrderInput,
  NewOrderInput,
  OrderRow,
  Session,
  WalletBalance,
} from "../../shared/api.ts";
import { fromDropcopy } from "../../shared/orders.ts";
import type { SubscribeRequest } from "../../shared/wire.ts";
import type { Backend, Feed, FeedHandlers } from "../backend.ts";
import { TmError } from "../tm/errors.ts";
import { SIM_CLIENT_ID, SimExchange, type SimConnection, type SimOrder } from "./exchange.ts";

interface SimWalletRow {
  assetId: string;
  economicAssetId: string;
  symbol: string;
  name: string;
  chain: string;
  free: number;
  allocated: number;
  stable: boolean;
}

// Demo mode: the routes run against SimExchange, and the wallet and custody moves are simulated here.
export class SimBackend implements Backend {
  readonly exchange: SimExchange;
  private wallet: SimWalletRow[];
  private moves: CustodyMove[] = [];
  private defiQuotes = new Map<string, DefiQuote>();
  private defiOrders = new Map<string, DefiOrderState>();

  constructor(exchange = new SimExchange()) {
    this.exchange = exchange;
    const usdc = randomUUID();
    this.wallet = [
      row("USDC", "USD Coin", "solana", 18_500, 0, true, usdc),
      row("USDC", "USD Coin", "base", 6_000, 25_000, true, usdc),
      ...exchange.instruments.map((i, n) => row(i.base, `${i.base} (tokenized)`, "base", [1.5, 12, 40][n] ?? 5, [4, 60, 120][n] ?? 10, false)),
    ];
    // What is allocated starts out credited to CeFi.
    for (const w of this.wallet) exchange.cefi.set(w.symbol, (exchange.cefi.get(w.symbol) ?? 0) + w.allocated);
  }

  async session(): Promise<Session> {
    return { mode: "demo", environment: "demo", clientId: SIM_CLIENT_ID, accountLabel: "demo-desk", warnings: [] };
  }

  async instruments(): Promise<Instrument[]> {
    return this.exchange.instruments.map((i) => {
      const d = this.exchange.instrumentData(i);
      return {
        id: d.id,
        symbol: d.info.symbol,
        status: d.status,
        baseAssetId: d.info.base_asset_id,
        quoteAssetId: d.info.quote_asset_id,
        referencePrice: d.info.reference_price,
        priceBandsPercent: d.info.price_bands_percent,
        notional24h: d.stats.last_24hr_notional,
        quantity24h: d.stats.last_24hr_quantity,
        defi: { assetId: this.wallet.find((w) => w.symbol === i.base)?.assetId ?? i.baseAssetId, chain: "base", symbol: i.base, decimals: 8 },
      };
    });
  }

  // A simulated DeFi swap: priced off the book with a little impact, a 0.1% fee, and checked
  // against the simulated wallet. It settles about a second and a half after execute.
  async quoteDefi(input: DefiOrderInput): Promise<DefiQuote> {
    const inst = this.exchange.instrument(input.symbol);
    const qty = Number(input.qty);
    if (!(qty > 0)) throw new TmError("qty must be positive", 400);
    const px = inst.fairTicks * inst.tick * (input.side === "BUY" ? 1.002 : 0.998);
    const buying = input.side === "BUY";
    const notional = buying ? qty : qty * px;
    const fee = notional * 0.001;
    const have = this.wallet.filter((w) => w.symbol === (buying ? "USDC" : inst.base)).reduce((s, w) => s + w.free, 0);
    const issues = have < qty ? ["Insufficient balance"] : [];
    const quote: DefiQuote = {
      orderId: issues.length ? "" : randomUUID(),
      side: input.side,
      symbol: input.symbol,
      chain: "base",
      qtyIn: input.qty,
      assetIn: buying ? "USDC" : inst.base,
      qtyOut: (buying ? (qty - fee) / px : qty * px - fee).toFixed(buying ? 6 : 2),
      assetOut: buying ? inst.base : "USDC",
      fee: fee.toFixed(4),
      feeAsset: "USDC",
      issues,
      executable: issues.length === 0,
      expiresAt: Date.now() + 60_000,
    };
    if (quote.executable) this.defiQuotes.set(quote.orderId, quote);
    return quote;
  }

  async executeDefi(orderId: string): Promise<DefiOrderState> {
    const q = this.defiQuotes.get(orderId);
    if (!q) throw new TmError("no quote waiting for that order; get a new quote", 404);
    this.defiQuotes.delete(orderId);
    if (Date.now() > q.expiresAt) throw new TmError("the quote is too old to execute; get a new quote", 409);
    const state: DefiOrderState = { orderId, status: "pending", side: q.side, symbol: q.symbol, chain: q.chain };
    this.defiOrders.set(orderId, state);
    this.later(1_500, () => {
      const take = (symbol: string, amt: number) => {
        for (const w of this.wallet.filter((r) => r.symbol === symbol).sort((a, b) => b.free - a.free)) {
          const used = Math.min(w.free, amt);
          w.free -= used;
          amt -= used;
        }
      };
      const give = (symbol: string, amt: number) => {
        const w = this.wallet.find((r) => r.symbol === symbol);
        if (w) w.free += amt;
      };
      take(q.assetIn, Number(q.qtyIn));
      give(q.assetOut, Number(q.qtyOut));
      const base = q.side === "BUY" ? Number(q.qtyOut) : Number(q.qtyIn);
      const usdc = q.side === "BUY" ? Number(q.qtyIn) : Number(q.qtyOut);
      Object.assign(state, {
        status: "complete",
        executedQty: base.toFixed(6),
        executedVwap: (usdc / base).toFixed(4),
        fee: q.fee,
        txHash: `0x${randomUUID().replace(/-/g, "")}`,
      });
    });
    return { ...state };
  }

  async defiOrder(orderId: string): Promise<DefiOrderState> {
    const s = this.defiOrders.get(orderId);
    if (!s) throw new TmError(`order ${orderId} not found`, 404);
    return { ...s };
  }

  async orders(): Promise<OrderRow[]> {
    return this.exchange.myOrders().map((o) => this.row(o));
  }

  async activeOrders(): Promise<OrderRow[]> {
    return this.exchange
      .myOrders()
      .filter((o) => o.status === "ACTIVE" || o.status === "NEW_PENDING")
      .map((o) => this.row(o));
  }

  private row(o: SimOrder): OrderRow {
    const row = fromDropcopy(this.exchange.dropcopyData(o));
    return { ...row, createdNs: o.createdNs };
  }

  async fills(): Promise<FillRow[]> {
    return this.exchange.fills.map((f) => ({
      id: `${f.matchId}:${f.order.id}`,
      orderId: f.order.id,
      symbol: f.order.instrument.symbol,
      side: f.order.side,
      price: this.exchange.px(f.order.instrument, f.ticks),
      qty: this.exchange.qty(f.order.instrument, f.lots),
      feeBps: f.liquidity === "MAKER" ? "2" : "5",
      liquidity: f.liquidity,
      timestampNs: f.timestampNs,
    }));
  }

  async placeOrder(input: NewOrderInput): Promise<{ orderId: string }> {
    return { orderId: this.exchange.submitMine(input).id };
  }

  async modifyOrder(orderId: string, input: ModifyOrderInput): Promise<void> {
    this.exchange.modifyMine(orderId, input.qty, input.price);
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.exchange.cancelMine(orderId);
  }

  async cancelAll(): Promise<CancelResult> {
    return { accepted: this.exchange.cancelAllMine(), failed: [] };
  }

  async balances(): Promise<Balances> {
    const ex = this.exchange;
    const holds = new Map<string, number>();
    for (const o of ex.myOrders()) {
      if (o.status !== "ACTIVE" && o.status !== "CANCEL_PENDING" && o.status !== "MODIFY_PENDING") continue;
      const qty = o.leaves * o.instrument.lot;
      if (o.side === "BUY") holds.set("USDC", (holds.get("USDC") ?? 0) + qty * o.ticks * o.instrument.tick);
      else holds.set(o.instrument.base, (holds.get(o.instrument.base) ?? 0) + qty);
    }
    const pendingReleases = new Map<string, number>();
    for (const m of this.moves) {
      // Held until the exchange has debited it; after that the CeFi balance already reflects it.
      if (m.kind === "release" && m.status === "debiting" && m.exchange?.status !== "COMPLETED") pendingReleases.set(m.symbol, (pendingReleases.get(m.symbol) ?? 0) + Number(m.amount));
    }
    const symbols = [...new Set(this.wallet.map((w) => w.symbol))];
    // Price each asset like the portfolio does: stablecoins at 1, the rest at the book's fair value.
    const prices: Balances["prices"] = {};
    for (const symbol of symbols) {
      const inst = ex.instruments.find((i) => i.base === symbol);
      const price = inst ? inst.fairTicks * inst.tick : 1;
      const walletFree = this.wallet.filter((w) => w.symbol === symbol).reduce((s, w) => s + w.free, 0);
      prices[symbol] = { price, valueUsd: (walletFree + (ex.cefi.get(symbol) ?? 0)) * price };
    }
    return {
      prices,
      wallet: this.wallet.map(
        (w): WalletBalance => ({
          assetId: w.assetId,
          economicAssetId: w.economicAssetId,
          symbol: w.symbol,
          name: w.name,
          chain: w.chain,
          total: String(w.free),
          available: String(w.free),
          held: "0",
          allocated: String(w.allocated),
          stable: w.stable,
          decimals: w.stable ? 6 : 8,
        }),
      ),
      cefi: symbols.map((symbol) => {
        const balance = ex.cefi.get(symbol) ?? 0;
        const orderHold = holds.get(symbol) ?? 0;
        const transferHold = pendingReleases.get(symbol) ?? 0;
        return {
          assetId: symbol,
          symbol,
          balance: balance.toFixed(6),
          unsettled: "0",
          orderHold: orderHold.toFixed(6),
          transferHold: transferHold.toFixed(6),
          tradable: (balance - orderHold - transferHold).toFixed(6),
          state: "OPEN",
        };
      }),
      feesHold: "0",
      unsettledFees: "0",
      cefiSymbols: symbols,
    };
  }

  async custody(): Promise<CustodyMove[]> {
    return [...this.moves].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async allocate(assetId: string, amount: string): Promise<CustodyMove> {
    const w = this.walletRow(assetId);
    const amt = positive(amount);
    if (this.moves.some((m) => m.kind === "allocation" && m.assetId === assetId && m.status !== "completed" && m.status !== "rejected")) {
      throw new TmError("an allocation for this asset is already in progress", 409);
    }
    if (amt > w.free) throw new TmError(`only ${w.free} ${w.symbol} is free in the wallet`, 422);
    // The amount is committed in the wallet straight away, and reaches CeFi once credited.
    w.free -= amt;
    w.allocated += amt;
    const move = this.newMove("allocation", w, amount, "allocating");
    move.allocatedTotal = String(w.allocated);
    // Like the real thing: the exchange transfer finishes in well under a second, and the gateway
    // marks the allocation completed a good while later.
    this.later(300, () => {
      this.exchange.cefi.set(w.symbol, (this.exchange.cefi.get(w.symbol) ?? 0) + amt);
      move.exchange = { ...move.exchange!, status: "COMPLETED", doneAt: new Date().toISOString() };
    });
    this.later(700, () => this.update(move, "crediting"));
    this.later(6_000, () => this.update(move, "completed"));
    return { ...move };
  }

  async release(assetId: string, amount: string): Promise<CustodyMove> {
    const w = this.walletRow(assetId);
    const amt = positive(amount);
    if (this.moves.some((m) => m.kind === "release" && m.assetId === assetId && m.status === "debiting")) {
      throw new TmError("a release for this asset is already in progress", 409);
    }
    if (amt > w.allocated) throw new TmError(`only ${w.allocated} ${w.symbol} is allocated from this wallet`, 422);
    const cefi = (await this.balances()).cefi.find((c) => c.symbol === w.symbol);
    if (amt > Number(cefi?.tradable ?? 0)) {
      throw new TmError(`only ${Number(cefi?.tradable ?? 0).toFixed(4)} ${w.symbol} is free on CeFi; cancel orders holding it first`, 422);
    }
    const move = this.newMove("release", w, amount, "debiting");
    this.later(300, () => {
      this.exchange.cefi.set(w.symbol, (this.exchange.cefi.get(w.symbol) ?? 0) - amt);
      move.exchange = { ...move.exchange!, status: "COMPLETED", doneAt: new Date().toISOString() };
    });
    this.later(6_000, () => {
      w.allocated -= amt;
      w.free += amt;
      this.update(move, "completed");
    });
    return { ...move };
  }

  openFeed(handlers: FeedHandlers): Feed {
    const conn: SimConnection = {
      send: (msg) => handlers.message(JSON.stringify(msg)),
      subs: new Set(),
      dropcopy: false,
      dropcopySeq: 0,
    };
    const ex = this.exchange;
    ex.connections.add(conn);
    conn.send({ channel: "WEBSOCKET", update: "WELCOME", message: "Welcome to the True Markets CeFi simulator", version: "1.0.0" });
    return {
      subscribe(req: SubscribeRequest) {
        ex.handleRequest(conn, req);
      },
      close() {
        ex.connections.delete(conn);
      },
    };
  }

  setStrategy(running: boolean): void {
    this.exchange.strategyRunning = running;
  }

  private walletRow(assetId: string): SimWalletRow {
    const w = this.wallet.find((r) => r.assetId === assetId);
    if (!w) throw new TmError(`asset ${assetId} is not a DeFi listing in this wallet`, 404);
    return w;
  }

  private newMove(kind: CustodyMove["kind"], w: SimWalletRow, amount: string, status: CustodyMove["status"]): CustodyMove {
    const now = new Date().toISOString();
    const move: CustodyMove = {
      id: randomUUID(),
      kind,
      status,
      assetId: w.assetId,
      symbol: w.symbol,
      amount,
      createdAt: now,
      updatedAt: now,
      exchange: { transferId: String(Date.now()), status: "PENDING" },
    };
    this.moves.push(move);
    return move;
  }

  private update(move: CustodyMove, status: CustodyMove["status"]): void {
    move.status = status;
    move.updatedAt = new Date().toISOString();
  }

  private later(ms: number, fn: () => void): void {
    setTimeout(fn, ms).unref?.();
  }
}

function row(symbol: string, name: string, chain: string, free: number, allocated: number, stable: boolean, economicAssetId = randomUUID()): SimWalletRow {
  return { assetId: randomUUID(), economicAssetId, symbol, name, chain, free, allocated, stable };
}

function positive(amount: string): number {
  const n = Number(amount);
  if (!(n > 0) || !/^\d+(\.\d+)?$/.test(amount)) throw new TmError("amount must be a positive decimal string", 400);
  return n;
}
