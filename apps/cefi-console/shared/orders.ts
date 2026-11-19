import type { OrderRow } from "./api.ts";
import type { DropcopyOrder, OrderStatus } from "./wire.ts";

const OPEN: ReadonlySet<OrderStatus> = new Set([
  "INITIALIZED",
  "NEW_PENDING",
  "ACTIVE",
  "CANCEL_PENDING",
  "MODIFY_PENDING",
]);

export function isOpen(status: OrderStatus): boolean {
  return OPEN.has(status);
}

// Only resting, unpending orders can take a cancel or a modify.
export function isActionable(status: OrderStatus): boolean {
  return status === "ACTIVE" || status === "NEW_PENDING";
}

export function fromDropcopy(o: DropcopyOrder): OrderRow {
  return {
    orderId: o.order_id,
    externalId: o.external_id || undefined,
    instrumentId: o.instrument_id,
    symbol: o.symbol,
    side: o.side,
    type: o.order_type,
    tif: o.time_in_force,
    status: o.status,
    price: nonZero(o.price),
    qty: o.quantity,
    leavesQty: o.leaves_qty ?? "0",
    executedQty: o.executed_qty ?? "0",
    vwap: nonZero(o.executed_vwap),
    createdNs: o.timestamp,
    updatedNs: o.timestamp,
    lastEvent: o.event_type,
    text: o.text || undefined,
  };
}

// The REST order shape (OrderActive plus timestamps) from GET /v1/cefi/orders and /orders/active.
export interface RestOrder {
  id?: string;
  order_id?: string;
  status?: OrderStatus;
  external_id?: string;
  order_info?: {
    instrument_id?: string;
    qty?: string;
    price?: string;
    side?: "BUY" | "SELL";
    type?: OrderRow["type"];
    tif?: OrderRow["tif"];
  };
  modify_info?: { new_qty?: string; new_price?: string };
  leaves_qty?: string;
  executed_qty?: string;
  executed_vwap?: string;
  timestamp?: string;
  update_timestamp?: string;
}

export function fromRest(o: RestOrder, symbolOf: (instrumentId: string) => string | undefined): OrderRow | undefined {
  const orderId = o.id ?? o.order_id;
  const info = o.order_info;
  if (!orderId || !info?.side || !o.status) return undefined;
  const instrumentId = info.instrument_id ?? "";
  // A modified order reports its original terms in order_info and the current ones in modify_info.
  const qty = nonZero(o.modify_info?.new_qty) ?? info.qty ?? "0";
  const price = nonZero(o.modify_info?.new_price) ?? nonZero(info.price);
  const created = o.timestamp ?? o.update_timestamp ?? "0";
  return {
    orderId,
    externalId: o.external_id || undefined,
    instrumentId,
    symbol: symbolOf(instrumentId) ?? instrumentId,
    side: info.side,
    type: info.type ?? "LIMIT",
    tif: info.tif ?? "GTC",
    status: o.status,
    price,
    qty,
    leavesQty: o.leaves_qty ?? "0",
    executedQty: o.executed_qty ?? "0",
    vwap: nonZero(o.executed_vwap),
    createdNs: created,
    updatedNs: o.update_timestamp ?? created,
  };
}

// Folds a newer view of an order into what we already have. An older message (a REST page that
// raced a DROPCOPY update) never overwrites a newer one, and the earliest time seen is kept as created.
export function mergeOrder(prev: OrderRow | undefined, next: OrderRow): OrderRow {
  if (!prev) return next;
  const created = minNs(prev.createdNs, next.createdNs);
  if (compareNs(next.updatedNs, prev.updatedNs) < 0) return { ...prev, createdNs: created };
  return {
    ...prev,
    ...stripUndefined(next),
    createdNs: created,
  };
}

export function compareNs(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function minNs(a: string, b: string): string {
  if (a === "0") return b;
  if (b === "0") return a;
  return compareNs(a, b) <= 0 ? a : b;
}

function nonZero(v: string | undefined): string | undefined {
  return v && Number(v) !== 0 ? v : undefined;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
