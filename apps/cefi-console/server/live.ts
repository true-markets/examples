import WebSocket from "ws";
import type {
  Balances,
  CancelResult,
  CefiBalance,
  CustodyMove,
  DefiOrderInput,
  DefiOrderState,
  DefiQuote,
  FillRow,
  Instrument,
  ModifyOrderInput,
  NewOrderInput,
  OrderRow,
  Session,
  WalletBalance,
} from "../shared/api.ts";
import { isCustodyPending } from "../shared/api.ts";
import { fromRest, mergeOrder, type RestOrder } from "../shared/orders.ts";
import type { SignedSubscription, SubscribeRequest } from "../shared/wire.ts";
import type { Backend, Feed, FeedHandlers } from "./backend.ts";
import { HOSTS, type Config } from "./env.ts";
import { claim, readApiKey, signWsRequest, stampPayload, TokenSource, unixSeconds, type ApiKey } from "./tm/auth.ts";
import { errorMessage, TmError } from "./tm/errors.ts";

type Query = Record<string, string | number | undefined>;

const PAGE = 100;
// A DeFi quote is executed within this long or not at all; the price it shows goes stale fast.
const DEFI_QUOTE_TTL_MS = 60_000;
// GET /orders and /orders/trade page with skip; stop after this many pages so one load stays bounded.
const MAX_PAGES = 10;

export class LiveBackend implements Backend {
  private readonly key: ApiKey;
  private readonly tokens: TokenSource;
  private readonly hosts;
  private instrumentCache: { at: number; list: Instrument[] } | undefined;
  private cefiAssetNames: Map<string, string> | undefined;
  // After a 429, requests to that API wait until the limit's window resets instead of adding to it.
  private pausedUntil: Record<"cefi" | "gateway", number> = { cefi: 0, gateway: 0 };
  private cache = new Map<string, { at: number; value: unknown; inflight?: Promise<unknown> }>();
  // Allocations and releases, newest first, with pending ones refreshed one by one.
  private moves: { at: number; list: CustodyMove[] } | undefined;
  private moveCheckedAt = new Map<string, number>();
  private transfersCheckedAt = 0;
  // Payloads of DeFi quotes waiting to be executed. They never leave the server.
  private pendingDefi = new Map<string, { payloads: { payload: string }[]; quote: DefiQuote }>();

  constructor(private readonly config: Config) {
    if (!config.keyFile) throw new Error("live mode needs an API key file");
    this.key = readApiKey(config.keyFile);
    this.hosts = HOSTS[config.environment];
    this.tokens = new TokenSource(this.key, this.hosts.auth);
  }

  // ---------- plumbing ----------

  private async request<T>(base: "cefi" | "gateway", method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const wait = this.pausedUntil[base] - Date.now();
    if (wait > 0) throw new TmError(`rate limited by True Markets; retrying in ${Math.ceil(wait / 1000)}s`, 429);
    const url = new URL(this.hosts[base] + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { authorization: `Bearer ${await this.tokens.token()}` };
    // CeFi REST rejects a request without a fresh timestamp, to guard against replays.
    if (base === "cefi") headers["x-truex-auth-timestamp"] = unixSeconds();
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    if (res.status === 429) {
      // X-RateLimit-Reset is seconds until the window resets.
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      this.pausedUntil[base] = Date.now() + (reset > 0 && reset < 120 ? reset * 1000 : 10_000);
      console.warn(`429 from ${base} on ${method} ${url.pathname}; pausing ${base} calls for ${Math.round((this.pausedUntil[base] - Date.now()) / 1000)}s`);
    }
    if (!res.ok) throw await TmError.from(res, `${method} ${url.pathname}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // A read shared by every browser tab: fresh for ttlMs, one request at a time, and if a refresh
  // fails (a 429, say) the last good value is served rather than an error.
  private async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.at < ttlMs) return entry.value as T;
    if (entry?.inflight) return entry.inflight as Promise<T>;
    const inflight = load()
      .then((value) => {
        this.cache.set(key, { at: Date.now(), value });
        return value;
      })
      .catch((err) => {
        if (entry) {
          this.cache.set(key, { at: entry.at, value: entry.value });
          return entry.value as T;
        }
        this.cache.delete(key);
        throw err;
      });
    this.cache.set(key, { at: entry?.at ?? 0, value: entry?.value, inflight });
    return inflight;
  }

  // List reads come wrapped as { data: [...], pagination } on both APIs.
  private async list<T>(base: "cefi" | "gateway", path: string, query?: Query): Promise<T[]> {
    const body = await this.request<T[] | { data?: T[] }>(base, "GET", path, { query });
    return Array.isArray(body) ? body : (body?.data ?? []);
  }

  // Every page of a CeFi list. Lists default to 10 rows; `size` goes up to 100, and the next page is
  // asked for by passing `pagination.next_cursor` back as `timestamp` until it comes back null.
  private async all<T>(path: string, query: Query = {}): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES * 5; page++) {
      const body = await this.request<T[] | { data?: T[]; pagination?: { next_cursor?: string | null } }>("cefi", "GET", path, {
        query: { ...query, size: PAGE, timestamp: cursor },
      });
      if (Array.isArray(body)) return body;
      out.push(...(body?.data ?? []));
      const next = body?.pagination?.next_cursor ?? undefined;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return out;
  }

  private async paged<T>(path: string, query: Query): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await this.list<T>("cefi", path, { ...query, size: PAGE, skip: page * PAGE });
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out;
  }

  private async clientId(): Promise<string> {
    if (this.config.clientId) return this.config.clientId;
    const fromToken = claim(await this.tokens.claims(), "client_id");
    if (fromToken) return fromToken;
    // Fall back to asking the exchange which client this token is scoped to.
    const clients = await this.list<{ id?: string }>("cefi", "/clients");
    const id = clients[0]?.id;
    if (!id) throw new Error("this API key is not enabled for CeFi trading: its token has no client_id");
    return id;
  }

  private async organizationId(): Promise<string | undefined> {
    return this.config.organizationId ?? claim(await this.tokens.claims(), "organization_id");
  }

  private async symbolMap(): Promise<(id: string) => string | undefined> {
    const byId = new Map((await this.instruments()).map((i) => [i.id, i.symbol]));
    return (id) => byId.get(id);
  }

  private async instrumentId(symbol: string): Promise<string> {
    const found = (await this.instruments()).find((i) => i.symbol === symbol);
    if (!found) throw new TmError(`unknown instrument ${symbol}`, 400);
    return found.id;
  }

  // ---------- Backend ----------

  async session(): Promise<Session> {
    const warnings: string[] = [];
    let clientId: string | null = null;
    try {
      clientId = await this.clientId();
    } catch (err) {
      warnings.push(errorMessage(err));
    }
    let accountLabel: string | null = this.config.accountLabel ?? null;
    if (!accountLabel) {
      // A personal key's token names the account's email in its subject.
      try {
        const sub = claim(await this.tokens.claims(), "sub");
        if (sub && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sub)) accountLabel = sub;
      } catch {
        // token errors are reported above
      }
    }
    if (!accountLabel) {
      try {
        // The client record names the account; the token itself carries no email or name.
        const clients = await this.cached("clients", 3_600_000, () => this.list<{ id?: string; info?: { mnemonic?: string } }>("cefi", "/clients"));
        const mnemonic = (clients.find((c) => c.id === clientId) ?? clients[0])?.info?.mnemonic;
        // Some accounts' mnemonic is an opaque hash, which reads worse than the client id.
        accountLabel = mnemonic && !/^[0-9a-f]{24,}$/i.test(mnemonic) ? mnemonic : null;
      } catch {
        // fall back to the client id in the header
      }
    }
    // No warning for a missing organization_id: only organization keys carry one (tm.organization_id),
    // and a personal key subscribes without it. If the exchange refuses a subscription, its own
    // confirmation message shows in the header.
    return { mode: "live", environment: this.config.environment, clientId, accountLabel, warnings };
  }

  async instruments(): Promise<Instrument[]> {
    if (this.instrumentCache && Date.now() - this.instrumentCache.at < 60_000) return this.instrumentCache.list;
    const raw = await this.all<{
      id: string;
      status: string;
      info: { symbol: string; base_asset_id?: string; quote_asset_id?: string; reference_price?: string; price_bands_percent?: string };
      stats?: { last_24hr_notional?: string; last_24hr_quantity?: string };
    }>("/instruments");
    const list = raw.map((i) => ({
      id: i.id,
      symbol: i.info.symbol,
      status: i.status,
      baseAssetId: i.info.base_asset_id,
      quoteAssetId: i.info.quote_asset_id,
      referencePrice: i.info.reference_price,
      priceBandsPercent: i.info.price_bands_percent,
      notional24h: i.stats?.last_24hr_notional,
      quantity24h: i.stats?.last_24hr_quantity,
    }));
    // Attach each book's DeFi listing, so the ticket can route there.
    const defi = await this.defiListings().catch(() => new Map<string, NonNullable<Instrument["defi"]>>());
    for (const i of list as Instrument[]) i.defi = defi.get(i.symbol);
    list.sort((a, b) => Number(b.notional24h ?? 0) - Number(a.notional24h ?? 0));
    this.instrumentCache = { at: Date.now(), list };
    return list;
  }

  async orders(): Promise<OrderRow[]> {
    const symbolOf = await this.symbolMap();
    const [history, active] = await Promise.all([
      this.paged<RestOrder>("/orders", { timestamp: nowNs() }),
      this.all<RestOrder>("/orders/active"),
    ]);
    const byId = new Map<string, OrderRow>();
    for (const raw of [...history, ...active]) {
      const row = fromRest(raw, symbolOf);
      if (row) byId.set(row.orderId, mergeOrder(byId.get(row.orderId), row));
    }
    return [...byId.values()];
  }

  async activeOrders(): Promise<OrderRow[]> {
    const symbolOf = await this.symbolMap();
    return (await this.all<RestOrder>("/orders/active"))
      .map((o) => fromRest(o, symbolOf))
      .filter((o): o is OrderRow => o !== undefined);
  }

  async fills(): Promise<FillRow[]> {
    const symbolOf = await this.symbolMap();
    const raw = await this.paged<{
      order_id: string;
      instrument_id: string;
      match_id: string;
      side: "BUY" | "SELL";
      trade_price: string;
      trade_qty: string;
      trade_fee_bps?: string;
      liq_flag?: FillRow["liquidity"];
      timestamp: string;
    }>("/orders/trade", { timestamp: nowNs() });
    return raw.map((t) => ({
      id: `${t.match_id}:${t.order_id}`,
      orderId: t.order_id,
      symbol: symbolOf(t.instrument_id) ?? t.instrument_id,
      side: t.side,
      price: t.trade_price,
      qty: t.trade_qty,
      feeBps: t.trade_fee_bps,
      liquidity: t.liq_flag,
      timestampNs: t.timestamp,
    }));
  }

  async placeOrder(input: NewOrderInput): Promise<{ orderId: string }> {
    const info: Record<string, unknown> = {
      client_id: await this.clientId(),
      instrument_id: await this.instrumentId(input.symbol),
      side: input.side,
      type: input.type,
      tif: input.tif,
      qty: input.qty,
      price: input.price ?? "0",
    };
    if (input.postOnly) info.exec_inst_flags = ["ALO"];
    // A market order sized in USDC: the exchange converts it to the base asset against the book.
    if (input.quoteQty) info.flags = ["QUOTE_QTY"];
    const res = await this.request<{ id?: string; data?: { id?: string } }>("cefi", "POST", "/orders", {
      body: { external_id: input.externalId, info },
    });
    return { orderId: res.id ?? res.data?.id ?? "" };
  }

  async modifyOrder(orderId: string, input: ModifyOrderInput): Promise<void> {
    await this.request("cefi", "PATCH", "/orders", {
      body: { id: orderId, info: { client_id: await this.clientId(), new_qty: input.qty, new_price: input.price } },
    });
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request("cefi", "DELETE", `/orders/${encodeURIComponent(orderId)}`);
  }

  async cancelAll(): Promise<CancelResult> {
    const res = await this.request<{ accepted?: string[]; data?: { accepted?: string[] } }>("cefi", "DELETE", "/orders/all");
    return { accepted: res.accepted ?? res.data?.accepted ?? [], failed: [] };
  }

  // Two gateway calls and one CeFi call, so it is cached briefly for every tab to share.
  balances(): Promise<Balances> {
    return this.cached("balances", 8_000, () => this.loadBalances());
  }

  private async loadBalances(): Promise<Balances> {
    const [rows, cefi, cefiSymbols, prices] = await Promise.all([
      this.list<{
        asset_id: string;
        economic_asset_id?: string;
        venue: "defi" | "cefi";
        symbol: string;
        name?: string;
        chain: string | null;
        total: string;
        available: string;
        held: string;
        allocated?: string;
        stable?: boolean;
        decimals?: number;
      }>("gateway", "/balances"),
      this.cefiBalances().catch(() => undefined),
      this.cefiSymbols().catch(() => [] as string[]),
      this.prices().catch(() => ({}) as Balances["prices"]),
    ]);
    const wallet: WalletBalance[] = rows
      .filter((r) => r.venue === "defi")
      .map((r) => ({
        assetId: r.asset_id,
        economicAssetId: r.economic_asset_id,
        symbol: r.symbol,
        name: r.name,
        chain: r.chain,
        total: r.total,
        available: r.available,
        held: r.held,
        allocated: r.allocated ?? "0",
        stable: r.stable ?? false,
        decimals: r.decimals,
      }));
    // Without CeFi REST access, fall back to the CeFi rows the gateway reports.
    const fallback: CefiBalance[] = rows
      .filter((r) => r.venue === "cefi")
      .map((r) => ({
        assetId: r.asset_id,
        symbol: r.symbol,
        balance: r.total,
        unsettled: "0",
        orderHold: r.held,
        transferHold: "0",
        tradable: r.available,
        state: "OPEN",
      }));
    return {
      prices,
      wallet,
      cefi: cefi?.balances ?? fallback,
      feesHold: cefi?.feesHold ?? "0",
      unsettledFees: cefi?.unsettledFees ?? "0",
      cefiSymbols,
    };
  }

  // USD price and value per asset from the portfolio, which values allocated funds once (through
  // the CeFi row) and counts funds still in transit to CeFi at that row's price.
  private async prices(): Promise<Balances["prices"]> {
    const body = await this.request<{
      balances?: { symbol: string; price?: string | null; value?: string | null; in_transit?: string }[];
    }>("gateway", "GET", "/portfolio");
    const out: Balances["prices"] = {};
    for (const b of body.balances ?? []) {
      const p = out[b.symbol] ?? (out[b.symbol] = { price: null, valueUsd: null });
      const price = b.price == null ? null : Number(b.price);
      if (price !== null) p.price = price;
      if (b.value != null) p.valueUsd = (p.valueUsd ?? 0) + Number(b.value);
      if (price !== null && Number(b.in_transit ?? 0) > 0) p.valueUsd = (p.valueUsd ?? 0) + Number(b.in_transit) * price;
    }
    return out;
  }

  private async cefiSymbols(): Promise<string[]> {
    return [...(await this.assetNames()).values()];
  }

  private async assetNames(): Promise<Map<string, string>> {
    if (this.cefiAssetNames) return this.cefiAssetNames;
    const assets = await this.all<{ id: string; fields?: { name?: string } }>("/assets");
    this.cefiAssetNames = new Map(assets.map((a) => [a.id, a.fields?.name ?? a.id]));
    return this.cefiAssetNames;
  }

  private async cefiBalances(): Promise<{ balances: CefiBalance[]; feesHold: string; unsettledFees: string }> {
    const [entities, names] = await Promise.all([
      this.list<{
        fees_hold?: string;
        unsettled_fees?: string;
        balances?: { asset_id: string; balance: string; unsettled?: string; order_hold?: string; transfer_hold?: string; state?: string }[];
      }>("cefi", "/balances"),
      this.assetNames(),
    ]);
    const entity = entities[0];
    const feesHold = entity?.fees_hold ?? "0";
    const unsettledFees = entity?.unsettled_fees ?? "0";
    const balances = (entity?.balances ?? []).map((b) => {
      const symbol = names.get(b.asset_id) ?? b.asset_id;
      let tradable = Number(b.balance) + Number(b.unsettled ?? 0) - Number(b.order_hold ?? 0) - Number(b.transfer_hold ?? 0);
      // The fee asset also carries the account-level fee holds. USDC settles fees on True Markets CeFi.
      if (symbol === "USDC") tradable -= Number(feesHold) + Math.max(0, Number(unsettledFees));
      return {
        assetId: b.asset_id,
        symbol,
        balance: b.balance,
        unsettled: b.unsettled ?? "0",
        orderHold: b.order_hold ?? "0",
        transferHold: b.transfer_hold ?? "0",
        tradable: String(tradable),
        state: b.state ?? "OPEN",
      };
    });
    return { balances, feesHold, unsettledFees };
  }

  // The lists are read every 30 seconds; a move still in progress is checked on its own, by id,
  // at most every 3 seconds. That keeps a pending allocation to one gateway call per check.
  async custody(): Promise<CustodyMove[]> {
    if (!this.moves || Date.now() - this.moves.at > 30_000) {
      try {
        const [allocations, releases] = await Promise.all([
          this.list<RawCustody>("gateway", "/custody/allocations", { limit: 25 }),
          this.list<RawCustody>("gateway", "/custody/releases", { limit: 25 }),
        ]);
        this.moves = { at: Date.now(), list: [...allocations.map((a) => toMove(a, "allocation")), ...releases.map((r) => toMove(r, "release"))] };
        // Just read, so nothing needs checking again for a few seconds.
        for (const m of this.moves.list) this.moveCheckedAt.set(m.id, Date.now());
      } catch (err) {
        if (!this.moves) throw err;
      }
    }
    const list = this.moves!.list;
    await this.followExchangeTransfers(list);
    await Promise.all(
      list.map(async (m, i) => {
        if (!isCustodyPending(m) || Date.now() - (this.moveCheckedAt.get(m.id) ?? 0) < 3_000) return;
        this.moveCheckedAt.set(m.id, Date.now());
        try {
          const raw = await this.request<RawCustody>("gateway", "GET", `/custody/${m.kind}s/${m.id}`);
          if (raw?.id !== m.id || !raw.status) return;
          const fresh = toMove(raw, m.kind);
          list[i] = fresh;
          // Once it lands, the balances it moved are stale.
          if (!isCustodyPending(fresh)) this.cache.delete("balances");
        } catch {
          // keep the last known state; the next check tries again
        }
      }),
    );
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // A pending move's exchange transfer usually finishes within a second, well before the gateway
  // marks the move completed. Reading the exchange's own transfers (a CeFi call, outside the gateway's
  // 100-a-minute limit) at most once a second shows that as soon as it happens.
  private async followExchangeTransfers(list: CustodyMove[]): Promise<void> {
    const waiting = list.filter((m) => isCustodyPending(m) && m.exchange && !["COMPLETED", "FAILED", "REJECTED"].includes(m.exchange.status));
    if (!waiting.length || Date.now() - this.transfersCheckedAt < 1_000) return;
    this.transfersCheckedAt = Date.now();
    try {
      const transfers = await this.list<{ id: string; status: string; updated_timestamp?: string }>("cefi", "/transfers", { size: 100, timestamp: nowNs() });
      const byId = new Map(transfers.map((t) => [String(t.id), t]));
      for (const m of waiting) {
        const t = byId.get(m.exchange!.transferId);
        if (!t) continue;
        const was = m.exchange!.status;
        m.exchange = {
          ...m.exchange!,
          status: t.status,
          doneAt: t.updated_timestamp ? new Date(Number(BigInt(t.updated_timestamp) / 1_000_000n)).toISOString() : undefined,
        };
        // The exchange balance changed, so the cached balances are stale now, not when the gateway says so.
        if (was !== t.status && t.status === "COMPLETED") this.cache.delete("balances");
      }
    } catch {
      // the gateway status still arrives on its own
    }
  }

  async allocate(assetId: string, amount: string): Promise<CustodyMove> {
    return this.track(toMove(await this.request<RawCustody>("gateway", "POST", "/custody/allocations", { body: { asset_id: assetId, amount } }), "allocation"));
  }

  async release(assetId: string, amount: string): Promise<CustodyMove> {
    return this.track(toMove(await this.request<RawCustody>("gateway", "POST", "/custody/releases", { body: { asset_id: assetId, amount } }), "release"));
  }

  // A new move goes straight into the list, so it is followed without re-reading the lists.
  private track(move: CustodyMove): CustodyMove {
    this.moves?.list.unshift(move);
    this.moveCheckedAt.set(move.id, Date.now());
    this.cache.delete("balances");
    return move;
  }

  // ---------- DeFi through the gateway ----------

  // CeFi instrument symbol → the DeFi listing of the same economic asset, from the public catalog.
  private defiListings(): Promise<Map<string, NonNullable<Instrument["defi"]>>> {
    return this.cached("defi-listings", 600_000, async () => {
      const assets = await this.list<{
        id: string;
        venue?: string;
        symbol: string;
        chain: string | null;
        economic_asset_id?: string;
        cefi_instrument?: string;
        order_types?: string[];
        decimals?: number;
      }>("gateway", "/assets", { product_type: "spot", asset_class: "crypto,stock" });
      const defiByEconomic = new Map<string, (typeof assets)[number]>();
      for (const a of assets) {
        if (a.venue === "defi" && a.economic_asset_id && a.order_types?.includes("market") && !defiByEconomic.has(a.economic_asset_id)) defiByEconomic.set(a.economic_asset_id, a);
      }
      const out = new Map<string, NonNullable<Instrument["defi"]>>();
      for (const a of assets) {
        if (a.venue !== "cefi" || !a.cefi_instrument || !a.economic_asset_id) continue;
        const d = defiByEconomic.get(a.economic_asset_id);
        if (d) out.set(a.cefi_instrument, { assetId: d.id, chain: d.chain, symbol: d.symbol, decimals: d.decimals });
      }
      return out;
    });
  }

  // Creates the order on the gateway, which returns a quote and the payloads to sign. Nothing trades
  // until executeDefi. Creating it can free funds allocated to CeFi to pay for it.
  async quoteDefi(input: DefiOrderInput): Promise<DefiQuote> {
    const inst = (await this.instruments()).find((i) => i.symbol === input.symbol);
    if (!inst?.defi) throw new TmError(`${input.symbol} has no DeFi listing`, 400);
    const res = await this.request<{
      order_id?: string;
      venue?: string;
      payloads?: { payload: string; digest?: string }[];
      quote?: { base_asset?: string; quote_asset?: string; qty?: string; qty_out?: string; fee?: string; fee_asset?: string; issues?: string[] };
    }>("gateway", "POST", "/orders", {
      body: {
        asset_id: inst.defi.assetId,
        venue: "defi",
        type: "market",
        side: input.side === "BUY" ? "buy" : "sell",
        qty: input.qty,
        // A DeFi buy is sized in the quote asset, a DeFi sell in the base asset.
        qty_unit: input.side === "BUY" ? "quote" : "base",
      },
    });
    if (res.venue && res.venue !== "defi") throw new TmError(`the gateway routed this to ${res.venue}, not DeFi`, 502);
    const q = res.quote ?? {};
    const base = q.base_asset ?? inst.defi.symbol;
    const quoteAsset = q.quote_asset ?? "USDC";
    const payloads = res.payloads ?? [];
    const quote: DefiQuote = {
      orderId: res.order_id ?? "",
      side: input.side,
      symbol: input.symbol,
      chain: inst.defi.chain,
      qtyIn: q.qty ?? input.qty,
      assetIn: input.side === "BUY" ? quoteAsset : base,
      qtyOut: q.qty_out ?? "0",
      assetOut: input.side === "BUY" ? base : quoteAsset,
      fee: q.fee ?? "0",
      feeAsset: q.fee_asset ?? quoteAsset,
      issues: q.issues ?? [],
      executable: !!res.order_id && payloads.length > 0,
      expiresAt: Date.now() + DEFI_QUOTE_TTL_MS,
    };
    if (quote.executable) this.pendingDefi.set(quote.orderId, { payloads, quote });
    return quote;
  }

  // Signs each payload with the API key (the same key is registered on the wallet) and executes.
  async executeDefi(orderId: string): Promise<DefiOrderState> {
    const pending = this.pendingDefi.get(orderId);
    if (!pending) throw new TmError("no quote waiting for that order; get a new quote", 404);
    this.pendingDefi.delete(orderId);
    if (Date.now() > pending.quote.expiresAt) throw new TmError("the quote is too old to execute; get a new quote", 409);
    const signatures = pending.payloads.map((p) => stampPayload(this.key, p.payload));
    const res = await this.request<{ status?: DefiOrderState["status"] }>("gateway", "POST", `/orders/${encodeURIComponent(orderId)}/execute`, {
      body: { signatures, auth_type: "api_key" },
    });
    this.cache.delete("balances");
    return { orderId, status: res.status ?? "pending", side: pending.quote.side, symbol: pending.quote.symbol, chain: pending.quote.chain };
  }

  async defiOrder(orderId: string): Promise<DefiOrderState> {
    const o = await this.request<{
      order_id: string;
      status: DefiOrderState["status"];
      side?: string;
      asset_symbol?: string;
      chain?: string;
      executed_qty?: string;
      executed_vwap?: string;
      fee?: string;
      tx_hash?: string;
      explorer_url?: string;
      failure_reason?: string;
    }>("gateway", "GET", `/orders/${encodeURIComponent(orderId)}`);
    if (o.status === "complete" || o.status === "failed") this.cache.delete("balances");
    return {
      orderId: o.order_id ?? orderId,
      status: o.status,
      side: o.side === "sell" ? "SELL" : o.side === "buy" ? "BUY" : undefined,
      symbol: o.asset_symbol,
      chain: o.chain ?? null,
      executedQty: o.executed_qty,
      executedVwap: o.executed_vwap,
      fee: o.fee,
      txHash: o.tx_hash,
      explorerUrl: o.explorer_url,
      failureReason: o.failure_reason,
    };
  }

  openFeed(handlers: FeedHandlers): Feed {
    const upstream = new WebSocket(this.hosts.ws);
    // The exchange refuses a signed request while an earlier one is still authenticating
    // ("Authentication already in progress"), so requests go out one at a time: each waits for
    // the exchange's confirmation of the one before it, or for a timeout.
    const queue: SubscribeRequest[] = [];
    let open = false;
    let inFlight = false;
    let timer: NodeJS.Timeout | undefined;

    const release = () => {
      clearTimeout(timer);
      inFlight = false;
      pump();
    };

    const pump = () => {
      if (!open || inFlight || upstream.readyState !== WebSocket.OPEN) return;
      const req = queue.shift();
      if (!req) return;
      inFlight = true;
      timer = setTimeout(release, 5_000);
      void send(req);
    };

    const send = async (req: SubscribeRequest) => {
      try {
        const msg: SignedSubscription = { type: req.type, channels: req.channels, item_names: req.item_names, timestamp: "" };
        // DROPCOPY items are client ids; the browser doesn't need to know ours.
        if (req.channels.includes("DROPCOPY") && req.item_names.length === 0) msg.item_names = [await this.clientId()];
        const organizationId = await this.organizationId();
        if (organizationId) msg.organization_id = organizationId;
        // Sign last, right before sending: the timestamp is only good for 15 seconds.
        Object.assign(msg, signWsRequest(this.key));
        upstream.send(JSON.stringify(msg));
      } catch (err) {
        handlers.message(JSON.stringify({ channel: "RELAY", status: "error", message: errorMessage(err) }));
        release();
      }
    };

    upstream.on("open", () => {
      open = true;
      pump();
    });
    upstream.on("message", (data) => {
      const text = data.toString();
      // A confirmation (channel WEBSOCKET, not the welcome) answers the request in flight.
      if (inFlight && text.includes('"channel":"WEBSOCKET"') && !text.includes('"update":"WELCOME"')) release();
      handlers.message(text);
    });
    upstream.on("close", (code, reason) => {
      clearTimeout(timer);
      handlers.closed(`upstream closed (${code}${reason.length ? `: ${reason}` : ""})`);
    });
    upstream.on("error", (err) => handlers.message(JSON.stringify({ channel: "RELAY", status: "error", message: err.message })));

    return {
      subscribe(req) {
        queue.push(req);
        pump();
      },
      close() {
        upstream.close();
      },
    };
  }
}

interface RawCustody {
  id: string;
  status: CustodyMove["status"];
  asset_id: string;
  asset_symbol: string;
  amount: string;
  allocated_total?: string;
  failure_reason?: string;
  created_at: string;
  updated_at: string;
  transfer?: { id: string; status: string };
}

function toMove(r: RawCustody, kind: CustodyMove["kind"]): CustodyMove {
  return {
    id: r.id,
    kind,
    status: r.status,
    assetId: r.asset_id,
    symbol: r.asset_symbol,
    amount: r.amount,
    allocatedTotal: r.allocated_total,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    exchange: r.transfer?.id ? { transferId: String(r.transfer.id), status: r.transfer.status } : undefined,
  };
}

function nowNs(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}
