// The live state the WebSocket keeps current: your orders, your fills, and per-symbol books, top of
// book, instrument stats and the trade tape. Components read it through the hooks at the bottom, and
// redraw at most once per animation frame however fast messages arrive.

import { useMemo, useSyncExternalStore } from "react";
import type { FillRow, OrderRow } from "../../shared/api.ts";
import { OrderBook } from "../../shared/book.ts";
import { fromDropcopy, mergeOrder } from "../../shared/orders.ts";
import type { DropcopyOrder, EbboData, InstrumentData, ServerMessage, TradeData } from "../../shared/wire.ts";

export type Slice = "orders" | "fills" | "market" | "conn";

export interface ConnState {
  socket: "connecting" | "open" | "closed";
  auth?: string;
  message?: string;
  lastMessageAt: number;
  reconnects: number;
}

export interface TapeTrade {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  price: string;
  qty: string;
  timestampNs: string;
  // "last": the book's last trade from before you opened the console (from its top-of-book
  // snapshot), so the tape isn't blank on books that rarely trade.
  source: "live" | "last";
}

const TAPE_LIMIT = 200;
const FILL_LIMIT = 2000;

class Store {
  readonly orders = new Map<string, OrderRow>();
  // When this browser last saw each order change, to flash rows that just moved.
  readonly touchedAt = new Map<string, number>();
  fills: FillRow[] = [];
  readonly books = new Map<string, OrderBook>();
  readonly ebbo = new Map<string, EbboData>();
  readonly instruments = new Map<string, InstrumentData>();
  readonly tape = new Map<string, TapeTrade[]>();
  conn: ConnState = { socket: "connecting", lastMessageAt: 0, reconnects: 0 };

  private versions: Record<Slice, number> = { orders: 0, fills: 0, market: 0, conn: 0 };
  private dirty = new Set<Slice>();
  private listeners = new Set<() => void>();
  private scheduled = false;
  // Symbols whose books we subscribe to; a snapshot for any other (one you just switched away
  // from, still in flight) is ignored. Kept by the feed client.
  depthWanted = new Set<string>();
  // Set by the feed client: asks for a fresh DEPTH snapshot after a skipped sequence number.
  onBookGap: (symbol: string) => void = () => {};

  version(slice: Slice): number {
    return this.versions[slice];
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  changed(slice: Slice): void {
    this.dirty.add(slice);
    if (this.scheduled) return;
    this.scheduled = true;
    const run = () => {
      this.scheduled = false;
      for (const s of this.dirty) this.versions[s]++;
      this.dirty.clear();
      for (const l of this.listeners) l();
    };
    if (typeof requestAnimationFrame === "function" && typeof document !== "undefined" && !document.hidden) requestAnimationFrame(run);
    else setTimeout(run, 50);
  }

  // ---------- seeding from REST ----------

  seedOrders(rows: OrderRow[]): void {
    for (const row of rows) this.orders.set(row.orderId, mergeOrder(this.orders.get(row.orderId), row));
    this.changed("orders");
  }

  // REST is the record; fills that arrived on the stream after the newest REST fill are kept on top.
  seedFills(rows: FillRow[]): void {
    const newest = rows.reduce((m, f) => (f.timestampNs > m ? f.timestampNs : m), "0");
    const live = this.fills.filter((f) => f.id.startsWith("live:") && f.timestampNs > newest);
    this.fills = [...live, ...[...rows].sort((a, b) => (a.timestampNs < b.timestampNs ? 1 : -1))].slice(0, FILL_LIMIT);
    this.changed("fills");
  }

  // ---------- WebSocket messages ----------

  handle(msg: ServerMessage): void {
    this.conn.lastMessageAt = Date.now();
    switch (msg.channel) {
      case "DROPCOPY":
        if (msg.update !== "SNAPSHOT_COMPLETE") this.applyOrder(msg.data);
        return;
      case "DEPTH": {
        if (msg.update === "SNAPSHOT_COMPLETE") return;
        const symbol = msg.data.symbol;
        let book = this.books.get(symbol);
        // A book starts from a snapshot. Updates without one (still in flight after an unsubscribe)
        // are dropped.
        if (!book) {
          if (msg.update !== "SNAPSHOT" || !this.depthWanted.has(symbol)) return;
          this.books.set(symbol, (book = new OrderBook(symbol)));
        }
        if (!book.apply(msg.update, msg.data, msg.seqnum)) this.onBookGap(symbol);
        this.changed("market");
        return;
      }
      case "EBBO":
        if (msg.update !== "SNAPSHOT_COMPLETE") {
          this.ebbo.set(msg.data.symbol, msg.data);
          // The exchange sends no trade history on subscribe; the snapshot's last trade is the
          // only earlier print there is, so it seeds an empty tape.
          if (msg.update === "SNAPSHOT") this.seedLastTrade(msg.data);
          this.changed("market");
        }
        return;
      case "INSTRUMENT":
        if (msg.update !== "SNAPSHOT_COMPLETE") {
          this.instruments.set(msg.data.info.symbol, msg.data);
          this.changed("market");
        }
        return;
      case "TRADE":
        if (msg.update !== "SNAPSHOT_COMPLETE") this.applyTrade(msg.data);
        return;
      case "WEBSOCKET":
        if (msg.update !== "WELCOME") {
          this.conn.auth = msg.status;
          if (msg.status === "ERROR" || msg.status === "UNAUTHORIZED" || msg.status === "INVALID" || msg.message) this.conn.message = msg.message ?? msg.status;
          else this.conn.message = undefined;
          this.changed("conn");
        }
        return;
      default:
        return;
    }
  }

  private applyOrder(o: DropcopyOrder): void {
    const row = fromDropcopy(o);
    this.orders.set(row.orderId, mergeOrder(this.orders.get(row.orderId), row));
    this.touchedAt.set(row.orderId, Date.now());
    this.changed("orders");
    if (o.event_type === "TRADE" && o.trade_qty && o.trade_price) {
      this.fills.unshift({
        id: `live:${o.order_id}:${o.timestamp}`,
        orderId: o.order_id,
        symbol: o.symbol,
        side: o.side,
        price: o.trade_price,
        qty: o.trade_qty,
        timestampNs: o.timestamp,
      });
      if (this.fills.length > FILL_LIMIT) this.fills.length = FILL_LIMIT;
      this.changed("fills");
    }
  }

  private applyTrade(t: TradeData): void {
    const list = this.tape.get(t.symbol) ?? [];
    if (list.some((x) => x.id === t.match_id)) return;
    // Live TRADE messages carry timestamp "0", so stamp them with when they arrived.
    const ts = t.info.timestamp && t.info.timestamp !== "0" ? t.info.timestamp : (BigInt(Date.now()) * 1_000_000n).toString();
    list.unshift({ id: t.match_id, symbol: t.symbol, side: t.taking_side, price: t.info.price, qty: t.info.qty, timestampNs: ts, source: "live" });
    list.sort((a, b) => (a.timestampNs < b.timestampNs ? 1 : -1));
    if (list.length > TAPE_LIMIT) list.length = TAPE_LIMIT;
    this.tape.set(t.symbol, list);
    this.changed("market");
  }

  private seedLastTrade(e: EbboData): void {
    const last = e.info.last_trade;
    if (!last?.timestamp || last.timestamp === "0" || !(Number(last.qty) > 0)) return;
    const list = this.tape.get(e.symbol) ?? [];
    if (list.length > 0) return;
    // The snapshot doesn't say which side took, so it shows as neither.
    list.push({ id: `last:${e.symbol}:${last.timestamp}`, symbol: e.symbol, side: "BUY", price: last.price, qty: last.qty, timestampNs: last.timestamp, source: "last" });
    this.tape.set(e.symbol, list);
    this.changed("market");
  }

  // Every book's tape, newest first.
  allTrades(): TapeTrade[] {
    return [...this.tape.values()].flat().sort((a, b) => (a.timestampNs < b.timestampNs ? 1 : -1));
  }

  // Forget a book we stopped subscribing to, so it can't be shown stale later.
  dropBook(symbol: string): void {
    this.books.delete(symbol);
    this.changed("market");
  }

  setConn(patch: Partial<ConnState>): void {
    Object.assign(this.conn, patch);
    this.changed("conn");
  }
}

export const store = new Store();

// ---------- hooks ----------

export function useVersion(slice: Slice): number {
  return useSyncExternalStore(store.subscribe, () => store.version(slice));
}

export function useOrders(): OrderRow[] {
  const v = useVersion("orders");
  return useMemo(() => [...store.orders.values()], [v]);
}

export function useFills(): FillRow[] {
  const v = useVersion("fills");
  return useMemo(() => [...store.fills], [v]);
}

export function useConn(): ConnState {
  const v = useVersion("conn");
  return useMemo(() => ({ ...store.conn }), [v]);
}

export function useMarket(): number {
  return useVersion("market");
}
