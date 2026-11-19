import type { DepthData, Level } from "./wire.ts";

export interface BookLevel {
  price: number;
  priceText: string;
  qty: number;
  orders: number;
}

// An L2 book built from DEPTH messages. A SNAPSHOT replaces the book; an UPDATE carries only the
// levels that changed, and a level with qty "0" is gone.
export class OrderBook {
  private bids = new Map<string, BookLevel>();
  private asks = new Map<string, BookLevel>();
  private lastSeq: number | undefined;

  constructor(readonly symbol: string) {}

  // Returns false when a sequence number was skipped, so the caller can resubscribe for a fresh snapshot.
  apply(update: "SNAPSHOT" | "UPDATE", data: DepthData, seqnum?: string): boolean {
    const seq = seqnum === undefined ? undefined : Number(seqnum);
    let inSequence = true;
    if (update === "SNAPSHOT") {
      this.bids.clear();
      this.asks.clear();
    } else if (seq !== undefined && this.lastSeq !== undefined && seq > this.lastSeq + 1) {
      // Only a jump forward is a gap. The exchange's first UPDATE after a SNAPSHOT carries the
      // snapshot's own seqnum, and levels are absolute sizes, so re-applying one is harmless.
      inSequence = false;
    }
    if (seq !== undefined && (this.lastSeq === undefined || seq > this.lastSeq || update === "SNAPSHOT")) this.lastSeq = seq;
    applySide(this.bids, data.bids);
    applySide(this.asks, data.asks);
    return inSequence;
  }

  clear(): void {
    this.bids.clear();
    this.asks.clear();
    this.lastSeq = undefined;
  }

  // Best first: highest bid, lowest ask.
  levels(): { bids: BookLevel[]; asks: BookLevel[] } {
    return {
      bids: [...this.bids.values()].sort((a, b) => b.price - a.price),
      asks: [...this.asks.values()].sort((a, b) => a.price - b.price),
    };
  }
}

function applySide(side: Map<string, BookLevel>, levels: Level[] | undefined): void {
  for (const l of levels ?? []) {
    const key = canonical(l.price);
    const qty = Number(l.qty);
    if (!(qty > 0)) {
      side.delete(key);
      continue;
    }
    side.set(key, {
      price: Number(l.price),
      priceText: l.price,
      qty,
      orders: Number(l.order_count ?? l.depth ?? 0),
    });
  }
}

// "100.50" and "100.5" are the same level.
export function canonical(price: string): string {
  return String(Number(price));
}
