// A small in-process CeFi exchange for demo mode and tests. It keeps a price-time order book per
// instrument, runs market makers that keep the book busy and a stand-in "strategy" that places,
// moves and cancels your orders, and publishes everything in the exact WebSocket formats the real
// exchange uses (see shared/wire.ts), so the browser code cannot tell the difference.

import { randomUUID } from "node:crypto";
import type { Channel, DropcopyOrder, Level, OrderEvent, OrderStatus, ServerMessage, Side, TimeInForce } from "../../shared/wire.ts";
import { TmError } from "../tm/errors.ts";

export interface SimInstrumentSpec {
  symbol: string;
  base: string;
  fair: number;
  tick: number;
  lot: number;
}

export const DEFAULT_INSTRUMENTS: SimInstrumentSpec[] = [
  { symbol: "TSLA-USDC", base: "TSLA", fair: 382.2, tick: 0.01, lot: 0.001 },
  { symbol: "NVDA-USDC", base: "NVDA", fair: 186.4, tick: 0.01, lot: 0.01 },
  { symbol: "PLTRC-USDC", base: "PLTRC", fair: 156.2, tick: 0.01, lot: 0.01 },
];

export interface SimInstrument extends SimInstrumentSpec {
  id: string;
  baseAssetId: string;
  fairTicks: number;
  priceDecimals: number;
  qtyDecimals: number;
  notional24h: number;
  quantity24h: number;
}

export interface SimOrder {
  id: string;
  owner: "mm" | "me";
  externalId?: string;
  instrument: SimInstrument;
  side: Side;
  type: "LIMIT" | "MARKET";
  tif: TimeInForce;
  postOnly: boolean;
  ticks: number;
  lots: number;
  leaves: number;
  executed: number;
  notional: number;
  status: OrderStatus;
  createdNs: string;
  updatedNs: string;
  lastEvent?: OrderEvent;
  text?: string;
  seq: number;
}

export interface SimFill {
  matchId: string;
  order: SimOrder;
  ticks: number;
  lots: number;
  liquidity: "MAKER" | "TAKER";
  timestampNs: string;
}

interface Book {
  bids: SimOrder[];
  asks: SimOrder[];
  dirty: Set<string>;
  lastBbo: string;
  trades: { matchId: string; side: Side; ticks: number; lots: number; ts: string }[];
}

export interface SimConnection {
  send(msg: ServerMessage): void;
  subs: Set<string>;
  dropcopy: boolean;
  dropcopySeq: number;
}

export const SIM_CLIENT_ID = "78901968715907076";
const FEE_BPS = { MAKER: 2, TAKER: 5 };

export class SimExchange {
  readonly instruments: SimInstrument[];
  readonly orders = new Map<string, SimOrder>();
  readonly fills: SimFill[] = [];
  readonly connections = new Set<SimConnection>();
  // CeFi balances by asset symbol, moved by fills and by allocations and releases.
  readonly cefi = new Map<string, number>();
  strategyRunning = true;

  private books = new Map<string, Book>();
  private seqs = new Map<string, number>();
  private nextId = 8_005_237_327_190_949_000n;
  private nextSeq = 0;
  private lastNs = 0n;
  private timers: NodeJS.Timeout[] = [];
  private rand: () => number;

  constructor(specs: SimInstrumentSpec[] = DEFAULT_INSTRUMENTS, seed = Date.now()) {
    this.rand = mulberry32(seed);
    this.instruments = specs.map((s, i) => ({
      ...s,
      id: String(79060284917576679n + BigInt(i)),
      baseAssetId: String(79060284836312029n + BigInt(i)),
      fairTicks: Math.round(s.fair / s.tick),
      priceDecimals: decimals(s.tick),
      qtyDecimals: decimals(s.lot),
      notional24h: 0,
      quantity24h: 0,
    }));
    for (const inst of this.instruments) {
      this.books.set(inst.symbol, { bids: [], asks: [], dirty: new Set(), lastBbo: "", trades: [] });
      for (let i = 0; i < 10; i++) this.makerQuote(inst);
      this.flush(inst);
    }
  }

  start(): void {
    this.timers.push(setInterval(() => this.instruments.forEach((i) => this.makerTick(i)), 350));
    this.timers.push(
      setInterval(() => {
        if (!this.strategyRunning) return;
        const inst = this.instruments[Math.floor(this.rand() * this.instruments.length)];
        if (inst) this.strategyTick(inst);
      }, 900),
    );
    this.timers.push(setInterval(() => this.heartbeats(), 5_000));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  instrument(symbol: string): SimInstrument {
    const inst = this.instruments.find((i) => i.symbol === symbol);
    if (!inst) throw new TmError(`unknown instrument ${symbol}`, 400);
    return inst;
  }

  // ---------- your orders ----------

  submitMine(input: {
    symbol: string;
    side: Side;
    type: "LIMIT" | "MARKET";
    tif: TimeInForce;
    qty: string;
    price?: string;
    postOnly?: boolean;
    quoteQty?: boolean;
    externalId?: string;
  }): SimOrder {
    const inst = this.instrument(input.symbol);
    // QUOTE_QTY: qty is USDC; convert at the touch, rounding down so a buy never spends more.
    const touch = input.side === "BUY" ? this.book(inst).asks[0]?.ticks : this.book(inst).bids[0]?.ticks;
    const lots = input.quoteQty
      ? Math.floor(Number(input.qty) / ((touch ?? inst.fairTicks) * inst.tick) / inst.lot)
      : Math.round(Number(input.qty) / inst.lot);
    if (!(lots > 0)) throw new TmError(`qty must be a positive multiple of ${inst.lot}`, 400);
    let ticks = 0;
    if (input.type === "LIMIT") {
      ticks = Math.round(Number(input.price) / inst.tick);
      if (!(ticks > 0)) throw new TmError("a LIMIT order needs a positive price", 400);
      const band = inst.fairTicks * 0.05;
      if (Math.abs(ticks - inst.fairTicks) > band) throw new TmError("price is outside the instrument's 5% price band", 400);
    }
    const order = this.newOrder(inst, "me", input.side, input.type, input.type === "MARKET" ? "IOC" : input.tif, ticks, lots);
    order.postOnly = input.postOnly ?? false;
    order.externalId = input.externalId;
    this.submit(order);
    return order;
  }

  cancelMine(orderId: string): void {
    const order = this.orders.get(orderId);
    if (!order || order.owner !== "me") throw new TmError(`order ${orderId} not found`, 404);
    if (order.status !== "ACTIVE" && order.status !== "NEW_PENDING") throw new TmError(`order ${orderId} is ${order.status} and cannot be canceled`, 400);
    this.setStatus(order, "CANCEL_PENDING");
    // A cancel takes a moment on a real exchange, and the order can still trade meanwhile.
    setTimeout(() => {
      if (order.status !== "CANCEL_PENDING") return;
      this.removeFromBook(order);
      this.setStatus(order, "CANCELED", "CANCELED");
      this.flush(order.instrument);
    }, 150 + this.rand() * 250);
  }

  modifyMine(orderId: string, qty: string, price: string): void {
    const order = this.orders.get(orderId);
    if (!order || order.owner !== "me") throw new TmError(`order ${orderId} not found`, 404);
    if (order.status !== "ACTIVE") throw new TmError(`order ${orderId} is ${order.status} and cannot be modified`, 400);
    const inst = order.instrument;
    const lots = Math.round(Number(qty) / inst.lot);
    const ticks = Math.round(Number(price) / inst.tick);
    if (!(lots > order.executed)) throw new TmError("new qty must be more than what has already filled", 400);
    if (!(ticks > 0)) throw new TmError("new price must be positive", 400);
    this.setStatus(order, "MODIFY_PENDING");
    setTimeout(() => {
      if (order.status !== "MODIFY_PENDING") return;
      this.removeFromBook(order);
      order.ticks = ticks;
      order.lots = lots;
      order.leaves = lots - order.executed;
      order.seq = this.nextSeq++;
      order.status = "ACTIVE";
      this.touch(order, "MODIFIED");
      this.emitDropcopy(order);
      // A modify loses time priority and can cross the book like a new order.
      this.match(order);
      if (order.leaves > 0 && order.status === "ACTIVE") this.rest(order);
      this.flush(inst);
    }, 120 + this.rand() * 200);
  }

  cancelAllMine(): string[] {
    const ids: string[] = [];
    for (const o of this.orders.values()) {
      if (o.owner === "me" && (o.status === "ACTIVE" || o.status === "NEW_PENDING")) {
        this.cancelMine(o.id);
        ids.push(o.id);
      }
    }
    return ids;
  }

  myOrders(): SimOrder[] {
    return [...this.orders.values()].filter((o) => o.owner === "me");
  }

  // ---------- WebSocket ----------

  handleRequest(conn: SimConnection, req: { type: string; channels: Channel[]; item_names: string[] }): void {
    const subscribe = req.type === "SUBSCRIBE" || req.type === "SUBSCRIBE_NO_AUTH";
    for (const channel of req.channels) {
      if (channel === "HEARTBEAT") {
        if (subscribe) conn.subs.add("HEARTBEAT:");
        else conn.subs.delete("HEARTBEAT:");
        continue;
      }
      if (channel === "DROPCOPY") {
        conn.dropcopy = subscribe;
        continue;
      }
      for (const item of req.item_names) {
        if (subscribe) conn.subs.add(`${channel}:${item}`);
        else conn.subs.delete(`${channel}:${item}`);
      }
    }
    conn.send({ channel: "WEBSOCKET", update: "SNAPSHOT", status: "AUTHENTICATED", timestamp: this.ns(), subscriptions: subscriptionsOf(conn) });
    if (!subscribe) return;
    for (const channel of req.channels) {
      if (channel === "DROPCOPY") this.dropcopySnapshot(conn);
      else for (const item of req.item_names) this.snapshot(conn, channel, item);
    }
  }

  private snapshot(conn: SimConnection, channel: Channel, symbol: string): void {
    const inst = this.instruments.find((i) => i.symbol === symbol);
    if (!inst) return;
    const book = this.book(inst);
    // Like the real exchange, a snapshot carries the seqnum its first following update will repeat.
    const seqnum = String((this.seqs.get(`${channel}:${symbol}`) ?? 0) + 1);
    const done = () => conn.send({ seqnum, channel, update: "SNAPSHOT_COMPLETE", item: symbol } as ServerMessage);
    if (channel === "DEPTH") {
      conn.send({ seqnum, channel, update: "SNAPSHOT", data: { symbol, bids: this.levels(inst, "BUY"), asks: this.levels(inst, "SELL") } });
    } else if (channel === "EBBO") {
      conn.send({ seqnum, channel, update: "SNAPSHOT", data: this.ebbo(inst) });
    } else if (channel === "INSTRUMENT") {
      conn.send({ seqnum, channel, update: "SNAPSHOT", data: this.instrumentData(inst) });
    } else if (channel === "TRADE") {
      for (const t of book.trades.slice(-30)) conn.send({ seqnum, channel, update: "SNAPSHOT", data: this.tradeData(inst, t) });
    } else return;
    done();
  }

  private dropcopySnapshot(conn: SimConnection): void {
    for (const o of this.myOrders()) {
      if (o.status === "ACTIVE" || o.status === "CANCEL_PENDING" || o.status === "MODIFY_PENDING" || o.status === "NEW_PENDING") {
        conn.send({ seqnum: String(++conn.dropcopySeq), channel: "DROPCOPY", update: "SNAPSHOT", data: this.dropcopyData(o) });
      }
    }
    conn.send({ seqnum: String(conn.dropcopySeq), channel: "DROPCOPY", update: "SNAPSHOT_COMPLETE", item: `CLIENT/${SIM_CLIENT_ID}` });
  }

  private publish(channel: Channel, symbol: string, build: (seqnum: string) => ServerMessage): void {
    const key = `${channel}:${symbol}`;
    const seq = (this.seqs.get(key) ?? 0) + 1;
    this.seqs.set(key, seq);
    let msg: ServerMessage | undefined;
    for (const c of this.connections) {
      if (!c.subs.has(key)) continue;
      msg ??= build(String(seq));
      c.send(msg);
    }
  }

  private emitDropcopy(order: SimOrder, trade?: { ticks: number; lots: number }): void {
    if (order.owner !== "me") return;
    const data = this.dropcopyData(order, trade);
    for (const c of this.connections) {
      if (c.dropcopy) c.send({ seqnum: String(++c.dropcopySeq), channel: "DROPCOPY", update: "UPDATE", data });
    }
  }

  private heartbeats(): void {
    for (const c of this.connections) {
      if (c.subs.has("HEARTBEAT:")) c.send({ channel: "HEARTBEAT", update: "HEARTBEAT", timestamp: this.ns() });
    }
  }

  // ---------- matching ----------

  private newOrder(inst: SimInstrument, owner: SimOrder["owner"], side: Side, type: SimOrder["type"], tif: TimeInForce, ticks: number, lots: number): SimOrder {
    const ns = this.ns();
    const order: SimOrder = {
      id: String(this.nextId++),
      owner,
      instrument: inst,
      side,
      type,
      tif,
      postOnly: false,
      ticks,
      lots,
      leaves: lots,
      executed: 0,
      notional: 0,
      status: "NEW_PENDING",
      createdNs: ns,
      updatedNs: ns,
      seq: this.nextSeq++,
    };
    if (owner === "me") this.orders.set(order.id, order);
    return order;
  }

  private submit(order: SimOrder): void {
    const inst = order.instrument;
    if (order.postOnly && this.wouldCross(order)) {
      order.status = "REJECTED";
      order.text = "post-only order would have crossed the book";
      this.touch(order, "REJECTED");
      this.emitDropcopy(order);
      return;
    }
    order.status = "ACTIVE";
    this.touch(order, "NEW");
    this.emitDropcopy(order);
    this.match(order);
    if (order.leaves > 0 && order.status === "ACTIVE") {
      if (order.tif === "IOC") this.setStatus(order, "CANCELED", "CANCELED", "IOC remainder canceled");
      else this.rest(order);
    }
    this.flush(inst);
  }

  private wouldCross(order: SimOrder): boolean {
    const best = order.side === "BUY" ? this.book(order.instrument).asks[0] : this.book(order.instrument).bids[0];
    return !!best && this.crosses(order, best);
  }

  private crosses(order: SimOrder, resting: SimOrder): boolean {
    if (order.type === "MARKET") return true;
    return order.side === "BUY" ? order.ticks >= resting.ticks : order.ticks <= resting.ticks;
  }

  private match(order: SimOrder): void {
    const inst = order.instrument;
    const book = this.book(inst);
    const contra = order.side === "BUY" ? book.asks : book.bids;
    while (order.leaves > 0 && contra.length > 0) {
      const resting = contra[0]!;
      if (!this.crosses(order, resting)) break;
      // Self-trade protection: never trade your own orders against each other.
      if (resting.owner === order.owner && order.owner === "me") break;
      const lots = Math.min(order.leaves, resting.leaves);
      const ts = this.ns();
      const matchId = String(BigInt(Date.now()) * 1000n + BigInt(this.nextSeq++));
      for (const [o, liquidity] of [
        [resting, "MAKER"],
        [order, "TAKER"],
      ] as const) {
        o.leaves -= lots;
        o.executed += lots;
        o.notional += lots * resting.ticks;
        o.updatedNs = ts;
        o.lastEvent = "TRADE";
        if (o.leaves === 0) o.status = "FILLED";
        if (o.owner === "me") {
          this.fills.push({ matchId, order: o, ticks: resting.ticks, lots, liquidity, timestampNs: ts });
          this.settle(o, resting.ticks, lots, liquidity);
        }
        this.emitDropcopy(o, { ticks: resting.ticks, lots });
      }
      if (resting.leaves === 0) contra.shift();
      book.dirty.add(`${resting.side}:${resting.ticks}`);
      const trade = { matchId, side: order.side, ticks: resting.ticks, lots, ts };
      book.trades.push(trade);
      if (book.trades.length > 200) book.trades.shift();
      inst.notional24h += lots * inst.lot * resting.ticks * inst.tick;
      inst.quantity24h += lots * inst.lot;
      this.publish("TRADE", inst.symbol, (seqnum) => ({ seqnum, channel: "TRADE", update: "UPDATE", data: this.tradeData(inst, trade) }));
    }
  }

  private settle(order: SimOrder, ticks: number, lots: number, liquidity: "MAKER" | "TAKER"): void {
    const inst = order.instrument;
    const qty = lots * inst.lot;
    const notional = qty * ticks * inst.tick;
    const fee = (notional * FEE_BPS[liquidity]) / 10_000;
    const sign = order.side === "BUY" ? 1 : -1;
    this.cefi.set(inst.base, (this.cefi.get(inst.base) ?? 0) + sign * qty);
    this.cefi.set("USDC", (this.cefi.get("USDC") ?? 0) - sign * notional - fee);
  }

  private rest(order: SimOrder): void {
    const book = this.book(order.instrument);
    const side = order.side === "BUY" ? book.bids : book.asks;
    side.push(order);
    side.sort((a, b) => (order.side === "BUY" ? b.ticks - a.ticks : a.ticks - b.ticks) || a.seq - b.seq);
    book.dirty.add(`${order.side}:${order.ticks}`);
  }

  private removeFromBook(order: SimOrder): void {
    const book = this.book(order.instrument);
    const side = order.side === "BUY" ? book.bids : book.asks;
    const i = side.indexOf(order);
    if (i >= 0) {
      side.splice(i, 1);
      book.dirty.add(`${order.side}:${order.ticks}`);
    }
  }

  private setStatus(order: SimOrder, status: OrderStatus, event?: OrderEvent, text?: string): void {
    order.status = status;
    order.text = text;
    this.touch(order, event);
    this.emitDropcopy(order);
  }

  private touch(order: SimOrder, event?: OrderEvent): void {
    order.updatedNs = this.ns();
    order.lastEvent = event;
  }

  // Publishes the levels that changed since the last flush, and the top of book if it moved.
  private flush(inst: SimInstrument): void {
    const book = this.book(inst);
    if (book.dirty.size > 0) {
      const bids: Level[] = [];
      const asks: Level[] = [];
      for (const key of book.dirty) {
        const [side, t] = key.split(":") as [Side, string];
        const level = this.level(inst, side, Number(t));
        (side === "BUY" ? bids : asks).push(level);
      }
      book.dirty.clear();
      this.publish("DEPTH", inst.symbol, (seqnum) => ({ seqnum, channel: "DEPTH", update: "UPDATE", data: { symbol: inst.symbol, bids, asks } }));
    }
    const bbo = `${book.bids[0]?.ticks}:${this.levelQty(book.bids)}|${book.asks[0]?.ticks}:${this.levelQty(book.asks)}`;
    if (bbo !== book.lastBbo) {
      book.lastBbo = bbo;
      this.publish("EBBO", inst.symbol, (seqnum) => ({ seqnum, channel: "EBBO", update: "UPDATE", data: this.ebbo(inst) }));
    }
  }

  private levelQty(side: SimOrder[]): number {
    const top = side[0]?.ticks;
    return side.filter((o) => o.ticks === top).reduce((s, o) => s + o.leaves, 0);
  }

  // ---------- market makers and the stand-in strategy ----------

  private makerTick(inst: SimInstrument): void {
    const drift = gaussian(this.rand) * 0.0006 * inst.fairTicks;
    inst.fairTicks = Math.max(1, Math.round(inst.fairTicks + drift));
    const book = this.book(inst);
    // Pull a few quotes, mostly the stale ones far from fair.
    for (const side of [book.bids, book.asks]) {
      const mm = side.filter((o) => o.owner === "mm");
      for (const o of mm) {
        const far = Math.abs(o.ticks - inst.fairTicks) > inst.fairTicks * 0.004;
        if ((far && this.rand() < 0.5) || this.rand() < 0.06) this.removeFromBook(o);
      }
    }
    for (let i = 0; i < 3; i++) this.makerQuote(inst);
    // Now and then someone takes liquidity, which can fill your resting orders.
    if (this.rand() < 0.35) {
      const side: Side = this.rand() < 0.5 ? "BUY" : "SELL";
      const lots = 1 + Math.floor(this.rand() * 25);
      const taker = this.newOrder(inst, "mm", side, "MARKET", "IOC", 0, lots);
      taker.status = "ACTIVE";
      this.match(taker);
    }
    this.flush(inst);
  }

  private makerQuote(inst: SimInstrument): void {
    const book = this.book(inst);
    const side: Side = book.bids.length < book.asks.length ? "BUY" : book.asks.length < book.bids.length ? "SELL" : this.rand() < 0.5 ? "BUY" : "SELL";
    if ((side === "BUY" ? book.bids : book.asks).length > 22) return;
    const spread = Math.max(1, Math.round(inst.fairTicks * 0.0002));
    const away = spread + Math.floor(this.rand() * this.rand() * inst.fairTicks * 0.003);
    let ticks = side === "BUY" ? inst.fairTicks - away : inst.fairTicks + away;
    // Makers never cross: they join or improve without taking.
    const bestAsk = book.asks[0]?.ticks;
    const bestBid = book.bids[0]?.ticks;
    if (side === "BUY" && bestAsk !== undefined) ticks = Math.min(ticks, bestAsk - 1);
    if (side === "SELL" && bestBid !== undefined) ticks = Math.max(ticks, bestBid + 1);
    const lots = 1 + Math.floor(this.rand() * 60);
    const order = this.newOrder(inst, "mm", side, "LIMIT", "GTC", ticks, lots);
    order.status = "ACTIVE";
    this.rest(order);
  }

  // Stands in for your automated strategy: keeps a couple of quotes near the top of the book on each
  // side, moves them as the market moves, and sometimes cancels or crosses. Pause it from the UI.
  strategyTick(inst: SimInstrument): void {
    const book = this.book(inst);
    const mine = this.myOrders().filter((o) => o.instrument === inst && o.status === "ACTIVE");
    const side: Side = this.rand() < 0.5 ? "BUY" : "SELL";
    const sideOrders = mine.filter((o) => o.side === side);
    const best = side === "BUY" ? book.bids[0]?.ticks : book.asks[0]?.ticks;
    if (best === undefined) return;
    const target = side === "BUY" ? best - Math.floor(this.rand() * 4) : best + Math.floor(this.rand() * 4);
    const lots = Math.max(1, Math.round((5 + this.rand() * 40) * (inst.lot >= 0.01 ? 1 : 10)));
    const fmt = (t: number) => (t * inst.tick).toFixed(inst.priceDecimals);
    const qty = (l: number) => (l * inst.lot).toFixed(inst.qtyDecimals);
    const roll = this.rand();
    try {
      if (sideOrders.length === 0 || (sideOrders.length < 3 && roll < 0.25)) {
        this.submitMine({ symbol: inst.symbol, side, type: "LIMIT", tif: "GTC", qty: qty(lots), price: fmt(target), externalId: `strat-${randomUUID().slice(0, 8)}` });
      } else if (roll < 0.65) {
        const o = sideOrders[Math.floor(this.rand() * sideOrders.length)]!;
        if (o.ticks !== target) this.modifyMine(o.id, qty(o.lots), fmt(target));
      } else if (roll < 0.85) {
        const o = sideOrders[Math.floor(this.rand() * sideOrders.length)]!;
        this.cancelMine(o.id);
      } else if (roll < 0.93) {
        this.submitMine({ symbol: inst.symbol, side, type: "MARKET", tif: "IOC", qty: qty(Math.max(1, Math.round(lots / 3))) });
      }
    } catch {
      // The strategy shrugs off its own rejects; the UI sees them on the order stream.
    }
  }

  // ---------- message builders ----------

  private book(inst: SimInstrument): Book {
    return this.books.get(inst.symbol)!;
  }

  private level(inst: SimInstrument, side: Side, ticks: number): Level {
    const orders = (side === "BUY" ? this.book(inst).bids : this.book(inst).asks).filter((o) => o.ticks === ticks);
    const lots = orders.reduce((s, o) => s + o.leaves, 0);
    return {
      price: this.px(inst, ticks),
      qty: lots === 0 ? "0" : this.qty(inst, lots),
      order_count: String(orders.length),
      last_update: this.lastNs.toString(),
    };
  }

  private levels(inst: SimInstrument, side: Side): Level[] {
    const seen = new Set<number>();
    const out: Level[] = [];
    for (const o of side === "BUY" ? this.book(inst).bids : this.book(inst).asks) {
      if (seen.has(o.ticks)) continue;
      seen.add(o.ticks);
      out.push(this.level(inst, side, o.ticks));
    }
    return out;
  }

  private ebbo(inst: SimInstrument) {
    const book = this.book(inst);
    const last = book.trades.at(-1);
    return {
      id: inst.id,
      symbol: inst.symbol,
      info: {
        last_trade: last ? { price: this.px(inst, last.ticks), qty: this.qty(inst, last.lots), timestamp: last.ts } : undefined,
        best_bid: book.bids[0] ? this.level(inst, "BUY", book.bids[0].ticks) : undefined,
        best_ask: book.asks[0] ? this.level(inst, "SELL", book.asks[0].ticks) : undefined,
        last_update: this.lastNs.toString(),
      },
    };
  }

  instrumentData(inst: SimInstrument) {
    return {
      id: inst.id,
      status: "ACTIVE" as const,
      info: {
        symbol: inst.symbol,
        reference_price: this.px(inst, inst.fairTicks),
        base_asset_id: inst.baseAssetId,
        quote_asset_id: "79053264372820547",
        price_limit_window_secs: "60",
        price_limit_percent: "0.05",
        price_bands_percent: "0.05",
      },
      stats: { last_24hr_notional: inst.notional24h.toFixed(2), last_24hr_quantity: inst.quantity24h.toFixed(inst.qtyDecimals) },
    };
  }

  private tradeData(inst: SimInstrument, t: { matchId: string; side: Side; ticks: number; lots: number; ts: string }) {
    return { match_id: t.matchId, taking_side: t.side, symbol: inst.symbol, info: { price: this.px(inst, t.ticks), qty: this.qty(inst, t.lots), timestamp: t.ts } };
  }

  dropcopyData(o: SimOrder, trade?: { ticks: number; lots: number }): DropcopyOrder {
    const inst = o.instrument;
    return {
      order_id: o.id,
      client_id: SIM_CLIENT_ID,
      instrument_id: inst.id,
      external_id: o.externalId,
      symbol: inst.symbol,
      side: o.side,
      order_type: o.type,
      time_in_force: o.tif,
      status: o.status,
      price: o.type === "LIMIT" ? this.px(inst, o.ticks) : "0",
      quantity: this.qty(inst, o.lots),
      leaves_qty: this.qty(inst, o.leaves),
      executed_qty: this.qty(inst, o.executed),
      executed_vwap: o.executed ? ((o.notional / o.executed) * inst.tick).toFixed(inst.priceDecimals + 2) : "0",
      event_type: trade ? "TRADE" : o.lastEvent,
      text: o.text,
      trade_price: trade ? this.px(inst, trade.ticks) : undefined,
      trade_qty: trade ? this.qty(inst, trade.lots) : undefined,
      timestamp: o.updatedNs,
    };
  }

  px(inst: SimInstrument, ticks: number): string {
    return (ticks * inst.tick).toFixed(inst.priceDecimals);
  }

  qty(inst: SimInstrument, lots: number): string {
    return (lots * inst.lot).toFixed(inst.qtyDecimals);
  }

  // Unix nanoseconds that never repeat or go backwards.
  ns(): string {
    let t = BigInt(Date.now()) * 1_000_000n;
    if (t <= this.lastNs) t = this.lastNs + 1n;
    this.lastNs = t;
    return t.toString();
  }
}

function subscriptionsOf(conn: SimConnection): { channel: Channel; item_names: string[] }[] {
  const by = new Map<Channel, string[]>();
  for (const key of conn.subs) {
    const [channel, item] = key.split(":") as [Channel, string];
    const list = by.get(channel) ?? [];
    if (item) list.push(item);
    by.set(channel, list);
  }
  if (conn.dropcopy) by.set("DROPCOPY", [SIM_CLIENT_ID]);
  return [...by].map(([channel, item_names]) => ({ channel, item_names }));
}

function decimals(step: number): number {
  const s = String(step);
  return s.includes(".") ? s.split(".")[1]!.length : 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
}
