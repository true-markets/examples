// TanStack DB collections for the data the tables query: your orders and your fills.
//
// The stream store (store.ts) stays the one place data comes in: it seeds from REST, folds in
// DROPCOPY updates, and keeps the newest view of each order. Once per frame it mirrors what changed
// into these collections through a sync adapter, in one batch. The tables then read them through live
// queries, so a filter is re-evaluated incrementally as orders change rather than over every row.
//
// Each record carries numeric copies of its decimal strings (priceN, qtyN, ...): DB compares values by
// type, and "382.1" > "1000" as text.

import { createCollection, type CollectionConfig } from "@tanstack/react-db";
import type { FillRow, OrderRow } from "../../shared/api.ts";
import { isOpen } from "../../shared/orders.ts";

export interface OrderRecord extends OrderRow {
  priceN: number | null;
  qtyN: number;
  executedN: number;
  leavesN: number;
  vwapN: number | null;
  // Share of the order that has filled, 0 to 1.
  filledPct: number;
  // qty × price at the limit; null for a market order.
  notionalN: number | null;
  createdMs: number;
  updatedMs: number;
  open: boolean;
  // A partially filled order that is still working.
  partial: boolean;
  // The status as the table shows it: PARTIAL for a partially filled working order.
  statusLabel: string;
  // The last event, or "" when there is none, so it can be filtered on.
  event: string;
}

export interface FillRecord extends FillRow {
  priceN: number;
  qtyN: number;
  notionalN: number;
  feeBpsN: number | null;
  timeMs: number;
}

const num = (v: string | undefined) => (v === undefined || v === "" ? null : Number(v));
const nsToMs = (ns: string) => (ns.length > 6 ? Number(ns.slice(0, -6)) : 0);

export function toOrderRecord(o: OrderRow): OrderRecord {
  const priceN = num(o.price);
  const qtyN = Number(o.qty);
  const executedN = Number(o.executedQty);
  return {
    ...o,
    priceN,
    qtyN,
    executedN,
    leavesN: Number(o.leavesQty),
    vwapN: num(o.vwap),
    filledPct: qtyN > 0 ? executedN / qtyN : 0,
    notionalN: priceN === null ? null : qtyN * priceN,
    createdMs: nsToMs(o.createdNs),
    updatedMs: nsToMs(o.updatedNs),
    open: isOpen(o.status),
    partial: o.status === "ACTIVE" && executedN > 0,
    statusLabel: o.status === "ACTIVE" && executedN > 0 ? "PARTIAL" : o.status.replace("_", " "),
    event: o.lastEvent ?? "",
  };
}

export function toFillRecord(f: FillRow): FillRecord {
  const priceN = Number(f.price);
  const qtyN = Number(f.qty);
  return { ...f, priceN, qtyN, notionalN: priceN * qtyN, feeBpsN: num(f.feeBps), timeMs: nsToMs(f.timestampNs) };
}

// A collection whose rows are pushed from outside (the stream store) rather than fetched by the
// collection itself. upsert() writes changed rows; replaceAll() also removes rows that are gone.
interface Mirror<T> {
  upsert(rows: T[]): void;
  replaceAll(rows: T[]): void;
}

function mirroredCollection<T extends object>(id: string, getKey: (row: T) => string) {
  type Write = { begin: () => void; write: (m: { type: "insert" | "update" | "delete"; value: T }) => void; commit: () => void };
  let sink: Write | undefined;
  // What has been written, by key. Rows pushed before the collection starts syncing wait here.
  const rows = new Map<string, T>();
  const written = new Set<string>();

  const flush = (changed: Iterable<string>, removed: Iterable<string>) => {
    if (!sink) return;
    const { begin, write, commit } = sink;
    let any = false;
    for (const key of changed) {
      const value = rows.get(key);
      if (!value) continue;
      if (!any) begin();
      any = true;
      write({ type: written.has(key) ? "update" : "insert", value });
      written.add(key);
    }
    for (const key of removed) {
      if (!written.has(key)) continue;
      if (!any) begin();
      any = true;
      write({ type: "delete", value: { ...(rows.get(key) ?? ({} as T)) } });
      written.delete(key);
    }
    if (any) commit();
  };

  const config: CollectionConfig<T, string> = {
    id,
    getKey,
    // Rows load as soon as anything queries them, and stay loaded.
    startSync: true,
    gcTime: 0,
    sync: {
      rowUpdateMode: "full",
      sync: ({ begin, write, commit, markReady }) => {
        sink = { begin, write: write as Write["write"], commit };
        written.clear();
        flush([...rows.keys()], []);
        markReady();
        return () => {
          sink = undefined;
        };
      },
    },
  };
  const collection = createCollection(config);

  const mirror: Mirror<T> = {
    upsert(batch) {
      const keys: string[] = [];
      for (const row of batch) {
        const key = getKey(row);
        rows.set(key, row);
        keys.push(key);
      }
      flush(keys, []);
    },
    replaceAll(batch) {
      const next = new Map(batch.map((r) => [getKey(r), r] as const));
      const removed = [...rows.keys()].filter((k) => !next.has(k));
      // Removed rows are written as deletes before they are dropped here.
      flush([], removed);
      for (const k of removed) rows.delete(k);
      for (const [k, v] of next) rows.set(k, v);
      flush(next.keys(), []);
    },
  };
  return { collection, mirror };
}

export const orders = mirroredCollection<OrderRecord>("orders", (o) => o.orderId);
export const fills = mirroredCollection<FillRecord>("fills", (f) => f.id);

export const ordersCollection = orders.collection;
export const fillsCollection = fills.collection;
