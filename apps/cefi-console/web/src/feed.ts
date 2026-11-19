// The browser side of the WebSocket. It connects to this app's /ws relay and keeps the exchange
// subscribed to a desired set of topics (channel + item):
//
// - Each confirmation from the exchange lists everything currently subscribed. A few seconds after
//   the last one, anything wanted but missing (for example refused with
//   SUBSCRIPTION_CHANGE_RATE_LIMIT_EXCEEDED) is requested again, with backoff.
// - Everything is sent again after a reconnect, since a new connection starts empty.
// - 30 seconds of silence counts as a dead connection. Heartbeats arrive after 10 quiet seconds,
//   so a live feed is never that quiet.
//
// Keep the topic count small: the exchange limits how many subscription changes you can make.

import type { Channel, ConfirmationMessage, RelayStatus, ServerMessage, SubscribeRequest } from "../../shared/wire.ts";
import { store } from "./store.ts";

const SILENCE_MS = 30_000;
const MAX_BACKOFF_MS = 15_000;
const SETTLE_MS = 3_000;
const MAX_RETRY_MS = 30_000;

// Channels that apply to the whole connection rather than to listed items.
const WHOLE: ReadonlySet<Channel> = new Set(["DROPCOPY", "HEARTBEAT"]);

class FeedClient {
  private ws: WebSocket | undefined;
  private wanted = new Map<Channel, Set<string>>();
  private confirmed = new Map<Channel, Set<string>>();
  private backoff = 1_000;
  private retryDelay = SETTLE_MS;
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private everOpened = false;
  // Called after a reconnect so REST views can catch up on what happened while we were away.
  onReconnect: () => void = () => {};

  start(): void {
    if (this.started) return;
    this.started = true;
    // At most one fresh-snapshot request per symbol every 5 seconds, so a feed that keeps skipping
    // can never turn into a resubscribe storm.
    const lastResync = new Map<string, number>();
    store.onBookGap = (symbol) => {
      if (Date.now() - (lastResync.get(symbol) ?? 0) < 5_000) return;
      lastResync.set(symbol, Date.now());
      this.send({ type: "UNSUBSCRIBE", channels: ["DEPTH"], item_names: [symbol] });
      this.send({ type: "SUBSCRIBE", channels: ["DEPTH"], item_names: [symbol] });
    };
    // Your orders, and heartbeats so a quiet market doesn't look like a dead line.
    this.setItems("DROPCOPY", []);
    this.setItems("HEARTBEAT", []);
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN && Date.now() - store.conn.lastMessageAt > SILENCE_MS) {
        store.setConn({ message: "no data for 30s; reconnecting" });
        this.ws.close();
      }
    }, 5_000);
  }

  stop(): void {
    clearInterval(this.watchdog);
    clearTimeout(this.reconcileTimer);
    this.started = false;
    this.ws?.close();
  }

  // Sets exactly which items a channel should carry, subscribing what is new and unsubscribing
  // what is no longer wanted. For DROPCOPY and HEARTBEAT pass [] (they cover the connection).
  setItems(channel: Channel, items: string[]): void {
    const next = new Set(items);
    const prev = this.wanted.get(channel);
    const whole = WHOLE.has(channel);
    this.wanted.set(channel, next);
    if (channel === "DEPTH") store.depthWanted = new Set(next);
    if (whole) {
      if (!prev) this.send({ type: "SUBSCRIBE", channels: [channel], item_names: [] });
      return;
    }
    const added = [...next].filter((i) => !prev?.has(i));
    const removed = [...(prev ?? [])].filter((i) => !next.has(i));
    if (removed.length) {
      this.send({ type: "UNSUBSCRIBE", channels: [channel], item_names: removed });
      if (channel === "DEPTH") removed.forEach((s) => store.dropBook(s));
    }
    if (added.length) this.send({ type: "SUBSCRIBE", channels: [channel], item_names: added });
  }

  private send(req: SubscribeRequest): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(req));
  }

  private sendAllWanted(): void {
    // Connection-wide channels first, so the first signed request is a small one.
    const order = [...this.wanted.keys()].sort((a, b) => Number(WHOLE.has(b)) - Number(WHOLE.has(a)));
    for (const ch of order) {
      const items = [...(this.wanted.get(ch) ?? [])];
      if (WHOLE.has(ch) || items.length) this.send({ type: "SUBSCRIBE", channels: [ch], item_names: WHOLE.has(ch) ? [] : items });
    }
  }

  private onConfirmation(msg: ConfirmationMessage): void {
    this.confirmed = new Map(msg.subscriptions.map((s) => [s.channel, new Set(s.item_names)]));
    // Wait for the confirmations still on their way to settle, then fill in what is missing.
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => this.reconcile(), this.retryDelay);
  }

  private reconcile(): void {
    let missingAny = false;
    for (const [ch, items] of this.wanted) {
      const have = this.confirmed.get(ch);
      if (WHOLE.has(ch)) {
        if (!have) {
          missingAny = true;
          this.send({ type: "SUBSCRIBE", channels: [ch], item_names: [] });
        }
        continue;
      }
      const missing = [...items].filter((i) => !have?.has(i));
      if (missing.length) {
        missingAny = true;
        this.send({ type: "SUBSCRIBE", channels: [ch], item_names: missing });
      }
    }
    // Back off while the exchange keeps refusing, and settle back once everything is in.
    this.retryDelay = missingAny ? Math.min(this.retryDelay * 2, MAX_RETRY_MS) : SETTLE_MS;
    if (missingAny) this.reconcileTimer = setTimeout(() => this.reconcile(), this.retryDelay);
  }

  private connect(): void {
    store.setConn({ socket: "connecting" });
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 1_000;
      this.retryDelay = SETTLE_MS;
      this.confirmed.clear();
      store.setConn({ socket: "open", message: undefined, lastMessageAt: Date.now() });
      this.sendAllWanted();
      if (this.everOpened) {
        store.setConn({ reconnects: store.conn.reconnects + 1 });
        this.onReconnect();
      }
      this.everOpened = true;
    };

    ws.onmessage = (e) => {
      let msg: ServerMessage | RelayStatus;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.channel === "RELAY") {
        if (msg.status !== "connected") store.setConn({ message: msg.message ?? msg.status });
        store.conn.lastMessageAt = Date.now();
        return;
      }
      store.handle(msg);
      if (msg.channel === "WEBSOCKET" && msg.update !== "WELCOME") this.onConfirmation(msg);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearTimeout(this.reconcileTimer);
      store.setConn({ socket: "closed" });
      if (!this.started) return;
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      setTimeout(() => this.started && this.connect(), wait);
    };
  }
}

export const feed = new FeedClient();
