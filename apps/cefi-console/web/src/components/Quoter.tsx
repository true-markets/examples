import { CircleAlert, Play, Plus, RotateCcw, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Panel as Pane } from "react-resizable-panels";
import { Divider, pane, Split } from "./Layout.tsx";
import type { QuoterBookSummary, QuoterDeskStatus, QuoterOrder, QuoterParamSpec, QuoterParams, QuoterStatus, QuoterTarget } from "../../../shared/api.ts";
import {
  useAddQuoterBook,
  useQuoterBook,
  useQuoterControl,
  useQuoterParams,
  useQuoterStatus,
  useRemoveQuoterBook,
  useSession,
  useUpdateQuoterParams,
} from "../api.ts";
import { price as fmtPrice, qty as fmtQty, usd as fmtUsd } from "../format.ts";
import { Button, cx, Empty, inputClass, Modal, Panel, StatusBadge } from "./ui.tsx";

// The management screen for a running cefi-quoter (apps/cefi-quoter). One quoter runs every book,
// all drawing on one shared view of the account's balances. Everything here comes from the
// quoter's own management API, read once a second through this app's server: which books it
// quotes, the balances they share, and for the selected book what it is quoting and why, its
// position, and every parameter, which you can change while it runs.

export function QuoterScreen() {
  const { data: session } = useSession();
  const status = useQuoterStatus(!!session?.quoter);
  const desk = status.data;
  const [picked, setPicked] = useState<string>();
  const books = desk?.books ?? [];
  // The picked book, or the first one if it's gone (removed) or nothing was picked yet.
  const selected = books.find((b) => b.market.symbol === picked)?.market.symbol ?? books[0]?.market.symbol;

  if (status.error && !desk) {
    return (
      <Panel title="Quoter">
        <Empty>
          <div className="space-y-1">
            <div className="text-sell">{status.error.message}</div>
            <div>
              Start it with <code className="num">go run .</code> in <code className="num">apps/cefi-quoter</code>, or check QUOTER_URL ({session?.quoter?.url}
              ).
            </div>
          </div>
        </Empty>
      </Panel>
    );
  }
  if (!desk) return <Empty>Connecting to the quoter…</Empty>;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <DeskBar d={desk} stale={!!status.error} />
      <Warnings list={desk.warnings} />
      <div className="min-h-0 flex-1">
        <Split id="quoter" orientation="horizontal">
          <Pane id="quoter-left" defaultSize="22" minSize={260}>
            <Split id="quoter-left" orientation="vertical">
              <Pane id="quoter-books" defaultSize="55" minSize={120}>
                <div className={pane}>
                  <BooksPanel d={desk} selected={selected} onSelect={setPicked} />
                </div>
              </Pane>
              <Divider vertical />
              <Pane id="quoter-balances" defaultSize="45" minSize={100}>
                <div className={pane}>
                  <SharedBalancesPanel d={desk} />
                </div>
              </Pane>
            </Split>
          </Pane>
          <Divider />
          <Pane id="quoter-book" defaultSize="78" minSize="40">
            <div className={pane}>
              {selected ? (
                <BookView key={selected} symbol={selected} live={desk.environment === "production"} paper={desk.mode === "paper"} />
              ) : (
                <Panel title="No books yet" className="h-full">
                  <Empty>Add a book on the left. It starts stopped, with a preview of what it would quote, until you start it.</Empty>
                </Panel>
              )}
            </div>
          </Pane>
        </Split>
      </div>
    </div>
  );
}

function Warnings({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <div className="rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-xs text-accent">
      {list.map((w) => (
        <div key={w} className="flex items-start gap-1.5">
          <CircleAlert size={13} className="mt-0.5 shrink-0" />
          {w}
        </div>
      ))}
    </div>
  );
}

// "BTC-USD" is a Coinbase product; "hyperliquid:xyz:GOOGL" is a Hyperliquid perp (tokenized stocks).
export function describeReference(ref: string): string {
  return ref.startsWith("hyperliquid:") ? `Hyperliquid ${ref.slice("hyperliquid:".length)}` : `Coinbase ${ref}`;
}

function stateTone(state: QuoterStatus["state"]) {
  return state === "quoting" ? "bg-buy-soft text-buy" : state === "waiting" ? "bg-accent-soft text-accent" : "bg-raised text-muted";
}

function StateBadge({ state }: { state: QuoterStatus["state"] }) {
  return (
    <span className={cx("inline-flex h-5 items-center gap-1.5 rounded px-1.5 text-[10px] font-bold tracking-wider", stateTone(state))}>
      {state === "quoting" && <span className="pulse inline-block size-1.5 rounded-full bg-current" />}
      {state.toUpperCase()}
    </span>
  );
}

// ---------- the whole quoter ----------

function DeskBar({ d, stale }: { d: QuoterDeskStatus; stale: boolean }) {
  const control = useQuoterControl();
  const [confirm, setConfirm] = useState(false);
  const live = d.environment === "production";
  const running = d.books.some((b) => b.enabled);
  const names: Record<string, string> = {
    orders: `Orders (${d.transport.toUpperCase()})`,
    dropcopy: "Drop copy",
    market: "Market data",
    reference: "Reference",
  };

  return (
    <section className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-panel px-3 py-2">
      <span className="text-sm font-semibold">Quoter</span>
      <span
        className={cx(
          "rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider",
          live ? "bg-sell-soft text-sell" : d.mode === "paper" ? "bg-info-soft text-info" : "bg-accent-soft text-accent",
        )}
        title={d.mode === "paper" ? "A simulated exchange priced off live reference prices; no orders reach True Markets" : undefined}
      >
        {live ? "LIVE" : d.environment.toUpperCase()}
      </span>
      <span className="text-[11px] text-muted">
        {d.books.length} book{d.books.length === 1 ? "" : "s"} · up since {new Date(d.startedAt).toLocaleTimeString()}
      </span>
      <span className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
        {(["orders", "dropcopy", "market", "reference"] as const).map((k) => {
          const c = d.connections[k];
          if (!c && k === "orders") return null;
          // Order entry and the reference only connect once there's a book to use them.
          const idle = d.books.length === 0 && (k === "reference" || k === "orders");
          return (
            <span key={k} title={idle ? "connects when the first book is added" : c?.reason} className="inline-flex items-center gap-1">
              <span className={cx("inline-block size-2 rounded-full", idle ? "bg-faint" : c?.up ? "bg-buy" : "bg-sell")} />
              {names[k]}
            </span>
          );
        })}
      </span>
      {stale && <span className="text-[11px] text-sell">· lost contact with the quoter, showing the last status</span>}
      <div className="ml-auto flex items-center gap-2">
        {running && (
          <Button
            tone="danger"
            disabled={control.isPending}
            onClick={() => control.mutate({ action: "stop" })}
            title="Stop every book and cancel every order the quoter has resting"
          >
            <Square size={12} /> Stop all
          </Button>
        )}
        {d.books.some((b) => !b.enabled) && (
          <Button disabled={control.isPending} onClick={() => (live ? setConfirm(true) : control.mutate({ action: "start" }))}>
            <Play size={12} /> Start all
          </Button>
        )}
      </div>
      {confirm && (
        <ConfirmStart
          title={`Start all ${d.books.length} books?`}
          body="Every book will place and keep moving real post-only orders on the production exchange, drawing on the shared balances. Stop all pulls every order."
          onClose={() => setConfirm(false)}
          onConfirm={() => control.mutate({ action: "start" })}
        />
      )}
    </section>
  );
}

function ConfirmStart({ title, body, onClose, onConfirm }: { title: string; body: string; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Not now</Button>
          <Button
            tone="primary"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Start quoting
          </Button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-muted">{body}</p>
    </Modal>
  );
}

function BooksPanel({ d, selected, onSelect }: { d: QuoterDeskStatus; selected?: string; onSelect: (s: string) => void }) {
  return (
    <Panel title="Books" className="h-full">
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1 divide-y divide-line/60 overflow-y-auto">
          {d.books.map((b) => (
            <BookRow key={b.market.symbol} b={b} active={b.market.symbol === selected} onSelect={() => onSelect(b.market.symbol)} />
          ))}
          {d.books.length === 0 && <Empty>None yet</Empty>}
        </div>
        <AddBook d={d} onAdded={onSelect} />
      </div>
    </Panel>
  );
}

function BookRow({ b, active, onSelect }: { b: QuoterBookSummary; active: boolean; onSelect: () => void }) {
  const pnl = Number(b.realizedPnl) + Number(b.unrealizedPnl);
  return (
    <button type="button" onClick={onSelect} className={cx("block w-full px-3 py-2 text-left hover:bg-raised", active && "bg-raised")}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold">{b.market.symbol}</span>
        <span className="ml-auto">
          <StateBadge state={b.state} />
        </span>
      </div>
      <div className="num mt-0.5 flex gap-2 text-[11px] text-muted">
        <span>{b.orders} orders</span>
        <span>
          pos {signed(b.position, 6)} {b.market.baseSymbol}
        </span>
        <span className="ml-auto">PnL {signed(pnl)}</span>
      </div>
      {b.reason && b.state === "waiting" && <div className="mt-0.5 truncate text-[11px] text-accent">{b.reason}</div>}
    </button>
  );
}

function AddBook({ d, onAdded }: { d: QuoterDeskStatus; onAdded: (s: string) => void }) {
  const add = useAddQuoterBook();
  const [symbol, setSymbol] = useState("");
  const [reference, setReference] = useState("");
  const listing = d.available.find((l) => l.symbol === symbol);
  if (d.available.length === 0) return null;
  return (
    <form
      className="space-y-1.5 border-t border-line px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!symbol) return;
        add.mutate(
          { symbol, reference: reference.trim() || undefined },
          {
            onSuccess: () => {
              onAdded(symbol);
              setSymbol("");
              setReference("");
            },
          },
        );
      }}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Add a book</div>
      <div className="flex gap-1.5">
        <select className={cx(inputClass, "min-w-0 flex-1")} value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Book to add">
          <option value="">Choose…</option>
          {d.available.map((l) => (
            <option key={l.symbol} value={l.symbol}>
              {l.symbol}
            </option>
          ))}
        </select>
        <Button tone="primary" type="submit" disabled={!symbol || add.isPending}>
          <Plus size={12} /> Add
        </Button>
      </div>
      {listing && (
        <label className="block text-[11px] text-faint">
          Reference price
          <input
            className={cx(inputClass, "mt-0.5 w-full")}
            placeholder={listing.reference || "required: hyperliquid:xyz:TICKER"}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
      )}
    </form>
  );
}

function SharedBalancesPanel({ d }: { d: QuoterDeskStatus }) {
  const th = "px-1.5 py-1.5 font-medium text-right";
  const td = "px-1.5 py-1.5 text-right";
  return (
    <Panel title="Shared balances" className="h-full">
      <div className="h-full overflow-y-auto">
        <div className="overflow-x-auto">
          <table className="num w-full text-xs">
            <thead className="text-[11px] text-muted">
              <tr className="border-b border-line">
                <th className={cx(th, "text-left")}>Asset</th>
                <th className={th} title="Balance less transfer holds and anything leaving at settlement, less fills since the last read">
                  Spendable
                </th>
                <th className={th} title="What every book's orders hold now">
                  Books
                </th>
                <th className={th} title="Held by orders this quoter didn't place (the console, another program)">
                  Other
                </th>
                <th className={th}>Free</th>
              </tr>
            </thead>
            <tbody>
              {d.balances.map((a) => (
                <tr key={a.assetId} className="border-b border-line/60">
                  <td className="px-1.5 py-1.5">{a.symbol || a.assetId}</td>
                  <td className={td}>{fmtQty(a.spendable)}</td>
                  <td className={td}>{fmtQty(a.ourHold)}</td>
                  <td className={cx(td, "text-faint")}>{Number(a.foreignHold) ? fmtQty(a.foreignHold) : "—"}</td>
                  <td className={td}>{fmtQty(a.free)}</td>
                </tr>
              ))}
              {d.balances.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <Empty>Not read yet</Empty>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-faint">
          One ledger for every book. A book takes funds from it before each new order or modify, so two books never spend the same balance. Read{" "}
          {d.balancesReadAt ? new Date(d.balancesReadAt).toLocaleTimeString() : "not yet"}; between reads it follows the books' own orders and fills live.
        </p>
      </div>
    </Panel>
  );
}

// ---------- one book ----------

function BookView({ symbol, live, paper }: { symbol: string; live: boolean; paper: boolean }) {
  const book = useQuoterBook(symbol);
  const s = book.data;
  if (!s) return book.error ? <Empty>{book.error.message}</Empty> : <Empty>Loading {symbol}…</Empty>;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <ControlBar s={s} live={live} />
      <Warnings list={s.warnings} />
      <div className="min-h-0 flex-1">
        <Split id="quoter-detail" orientation="vertical">
          <Pane id="quoter-cards" defaultSize="26" minSize={80}>
            <div className={cx(pane, "overflow-y-auto")}>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
                <PricesCard s={s} paper={paper} />
                <PositionCard s={s} />
                <BalancesCard s={s} />
                <ActivityCard s={s} />
              </div>
            </div>
          </Pane>
          <Divider vertical />
          <Pane id="quoter-work" defaultSize="52" minSize={150}>
            <Split id="quoter-work" orientation="horizontal">
              <Pane id="quoter-ladder" defaultSize="60" minSize={320}>
                <div className={pane}>
                  <LadderPanel s={s} />
                </div>
              </Pane>
              <Divider />
              <Pane id="quoter-params" defaultSize="40" minSize={260}>
                <div className={pane}>
                  <ParamsPanel symbol={symbol} s={s} />
                </div>
              </Pane>
            </Split>
          </Pane>
          <Divider vertical />
          <Pane id="quoter-events" defaultSize="22" minSize={80}>
            <div className={pane}>
              <EventsPanel s={s} />
            </div>
          </Pane>
        </Split>
      </div>
    </div>
  );
}

function ControlBar({ s, live }: { s: QuoterStatus; live: boolean }) {
  const control = useQuoterControl();
  const remove = useRemoveQuoterBook();
  const [confirm, setConfirm] = useState(false);
  const symbol = s.market.symbol;

  return (
    <section className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-panel px-3 py-2">
      <span className={cx("inline-flex h-6 items-center gap-1.5 rounded px-2 text-[11px] font-bold tracking-wider", stateTone(s.state))}>
        {s.state === "quoting" && <span className="pulse inline-block size-1.5 rounded-full bg-current" />}
        {s.state.toUpperCase()}
      </span>
      {s.reason && s.state !== "stopped" && <span className="text-xs text-accent">{s.reason}</span>}
      <span className="text-sm font-semibold">{symbol}</span>
      <span className="text-[11px] text-muted">reference {describeReference(s.market.reference)}</span>
      <div className="ml-auto flex items-center gap-2">
        {!s.enabled && s.orders.length === 0 && (
          <Button tone="ghost" size="xs" disabled={remove.isPending} onClick={() => remove.mutate(symbol)} title="Stop managing this book">
            <Trash2 size={12} /> Remove
          </Button>
        )}
        {s.enabled ? (
          <Button
            tone="danger"
            disabled={control.isPending}
            onClick={() => control.mutate({ action: "stop", symbol })}
            title="Stop this book and cancel its resting orders"
          >
            <Square size={12} /> Stop and pull quotes
          </Button>
        ) : (
          <Button tone="primary" disabled={control.isPending} onClick={() => (live ? setConfirm(true) : control.mutate({ action: "start", symbol }))}>
            <Play size={12} /> Start quoting
          </Button>
        )}
      </div>
      {confirm && (
        <ConfirmStart
          title={`Start quoting ${symbol}?`}
          body={`The quoter will place and keep moving real post-only orders on the production exchange, using up to ${fmtQty(s.balances.budgetQuote, 2)} ${s.market.quoteSymbol} and ${fmtQty(s.balances.budgetBase)} ${s.market.baseSymbol}. The ladder below shows what it will quote first. Stop pulls every order.`}
          onClose={() => setConfirm(false)}
          onConfirm={() => control.mutate({ action: "start", symbol })}
        />
      )}
    </section>
  );
}

// ---------- cards ----------

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-line bg-panel px-3 py-2">
      <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">{children}</dl>
    </section>
  );
}

function Row({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <>
      <dt className="text-muted" title={title}>
        {label}
      </dt>
      <dd className="num text-right">{children}</dd>
    </>
  );
}

function signed(v: string | number, decimals = 2) {
  const n = Number(v);
  return <span className={n > 0 ? "text-buy" : n < 0 ? "text-sell" : ""}>{(n > 0 ? "+" : "") + fmtQty(n, decimals)}</span>;
}

function PricesCard({ s, paper }: { s: QuoterStatus; paper: boolean }) {
  const ref = s.reference;
  return (
    <Card title="Prices">
      <Row label="Reference" title={`${describeReference(s.market.reference)}; the age is since its price last changed`}>
        {ref ? fmtPrice(ref.mid) : "—"} <span className="text-faint">{ref ? `${(ref.ageMs / 1000).toFixed(1)}s` : ""}</span>
      </Row>
      <Row label="Quoting mid" title="The reference after inventory skew">
        {s.mid ? fmtPrice(s.mid) : "—"}
      </Row>
      <Row label="Skew">{s.skewBps ? `${s.skewBps.toFixed(2)} bps` : "none"}</Row>
      <Row label="Exchange bid / ask">
        {paper ? (
          <span className="text-faint">none in paper mode</span>
        ) : (
          <>
            <span className="text-buy">{s.bestBid ? fmtPrice(s.bestBid) : "—"}</span> /{" "}
            <span className="text-sell">{s.bestAsk ? fmtPrice(s.bestAsk) : "—"}</span>
          </>
        )}
      </Row>
    </Card>
  );
}

function PositionCard({ s }: { s: QuoterStatus }) {
  const p = s.position;
  const base = s.market.baseSymbol;
  const quote = s.market.quoteSymbol;
  const max = Number(s.params.maxPosition ?? 0);
  return (
    <Card title="Position (since start)">
      <Row label="Change" title="Bought minus sold since the quoter started, against the max position change">
        {signed(p.qty, 8)} {base}
        {max > 0 && (
          <span className="text-faint">
            {" "}
            of ±{fmtQty(max)}
            {s.params.sizeUnit === "quote" ? ` ${quote}` : ""}
          </span>
        )}
      </Row>
      <Row label="Avg cost">{Number(p.qty) === 0 ? "—" : fmtPrice(p.avgCost)}</Row>
      <Row label="Realized PnL">
        {signed(p.realizedPnl)} {quote}
      </Row>
      <Row label="Unrealized PnL" title="The open position marked to the reference mid">
        {signed(p.unrealizedPnl)} {quote}
      </Row>
      <Row label="Volume">
        {fmtQty(p.volumeBase)} {base} · {fmtQty(p.volumeQuote, 2)} {quote}
      </Row>
    </Card>
  );
}

function BalancesCard({ s }: { s: QuoterStatus }) {
  const b = s.balances;
  const base = s.market.baseSymbol;
  const quote = s.market.quoteSymbol;
  return (
    <Card title="Budget">
      <Row
        label={`${quote} held / budget`}
        title="What this book's bids hold now, out of what they may hold: what they hold plus the shared free balance, capped by maxQuoteAlloc"
      >
        {fmtQty(b.heldQuote, 2)} / {fmtQty(b.budgetQuote, 2)}
      </Row>
      <Row label={`${base} held / budget`} title="What the asks hold now, out of what they may hold">
        {fmtQty(b.heldBase)} / {fmtQty(b.budgetBase)}
      </Row>
      <Row label="Free (shared)" title="Free in the ledger every book draws on">
        {fmtQty(b.freeQuote, 2)} {quote} · {fmtQty(b.freeBase)} {base}
      </Row>
      <Row label="Read">{b.readAt ? new Date(b.readAt).toLocaleTimeString() : "not yet"}</Row>
    </Card>
  );
}

function ActivityCard({ s }: { s: QuoterStatus }) {
  const st = s.stats;
  return (
    <Card title="Activity">
      <Row label="Requests" title="Since this book was added">
        {st.creates} new · <span className="text-info">{st.modifies} modify</span> · {st.cancels} cancel
      </Row>
      <Row label="Fills / rejects">
        <span className="text-buy">{st.fills}</span> / <span className={st.rejects ? "text-sell" : ""}>{st.rejects}</span>
        {st.errors > 0 && <span className="text-sell"> · {st.errors} errors</span>}
      </Row>
      <Row label="Modify share" title="Of the requests that changed a resting order, how many were modifies rather than cancels">
        {st.modifies + st.cancels ? `${Math.round((100 * st.modifies) / (st.modifies + st.cancels))}%` : "—"}
      </Row>
    </Card>
  );
}

// ---------- ladder ----------

function LadderPanel({ s }: { s: QuoterStatus }) {
  const levels = Math.max(Number(s.params.levels ?? 0), ...s.orders.map((o) => o.level + 1), ...s.targets.map((t) => t.level + 1));
  const find = <T extends { level: number }>(list: T[], side: string, level: number, sideOf: (x: T) => string) =>
    list.find((x) => x.level === level && sideOf(x) === side);
  const rows = Array.from({ length: levels }, (_, level) => ({
    level,
    bid: find(s.orders, "BUY", level, (o) => o.side),
    ask: find(s.orders, "SELL", level, (o) => o.side),
    bidTarget: find(s.targets, "BUY", level, (t: QuoterTarget) => t.side),
    askTarget: find(s.targets, "SELL", level, (t: QuoterTarget) => t.side),
  }));
  const th = "px-2 py-1.5 font-medium";
  return (
    <Panel className="h-full" title={s.enabled ? "Ladder" : "Ladder (preview: what it would quote)"}>
      <div className="h-full overflow-auto">
        <div className="overflow-x-auto">
          <table className="num w-full text-xs">
            <thead className="text-[11px] text-muted">
              <tr className="border-b border-line">
                <th className={cx(th, "text-left")}>Status</th>
                <th className={cx(th, "text-right")}>Size</th>
                <th className={cx(th, "text-right text-buy")}>Bid</th>
                <th className={cx(th, "text-right")}>Target</th>
                <th className={cx(th, "text-center")}>Lvl</th>
                <th className={cx(th, "text-left")}>Target</th>
                <th className={cx(th, "text-left text-sell")}>Ask</th>
                <th className={cx(th, "text-left")}>Size</th>
                <th className={cx(th, "text-right")}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.level} className="border-b border-line/60">
                  <td className="px-2 py-1.5">{r.bid && <OrderBadge o={r.bid} />}</td>
                  <td className="px-2 py-1.5 text-right">
                    {r.bid ? <Size o={r.bid} /> : r.bidTarget ? <TargetSize t={r.bidTarget} /> : null}
                  </td>
                  <td className="px-2 py-1.5 text-right text-buy">{r.bid ? <OrderPrice o={r.bid} /> : "—"}</td>
                  <td className="px-2 py-1.5 text-right text-faint">{r.bidTarget ? fmtPrice(r.bidTarget.price) : ""}</td>
                  <td className="px-2 py-1.5 text-center text-muted">{r.level}</td>
                  <td className="px-2 py-1.5 text-faint">{r.askTarget ? fmtPrice(r.askTarget.price) : ""}</td>
                  <td className="px-2 py-1.5 text-sell">{r.ask ? <OrderPrice o={r.ask} /> : "—"}</td>
                  <td className="px-2 py-1.5">
                    {r.ask ? <Size o={r.ask} /> : r.askTarget ? <TargetSize t={r.askTarget} /> : null}
                  </td>
                  <td className="px-2 py-1.5 text-right">{r.ask && <OrderBadge o={r.ask} />}</td>
                </tr>
              ))}
              {levels === 0 && (
                <tr>
                  <td colSpan={9}>
                    <Empty>Nothing to show yet</Empty>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-faint">
          Target is where the strategy wants each order this cycle; Bid and Ask are where the orders rest, with an arrow while a modify is in flight. An order
          only moves once its target is at least the modify threshold away ({s.params.modifyThresholdBps} bps). Size is what is still resting, in{" "}
          {s.market.baseSymbol}, with its value in dollars ({s.market.quoteSymbol}) under it.
        </p>
      </div>
    </Panel>
  );
}

function OrderBadge({ o }: { o: QuoterOrder }) {
  return (
    <span title={`${o.externalId}${o.orderId ? ` · exchange id ${o.orderId}` : ""}${o.pendingMs ? ` · waiting ${o.pendingMs}ms` : ""}`}>
      <StatusBadge status={o.status} partial={Number(o.executed) > 0} />
    </span>
  );
}

function OrderPrice({ o }: { o: QuoterOrder }) {
  if (o.pendingPrice && o.pendingPrice !== o.price) {
    return (
      <span>
        <span className="text-faint">{fmtPrice(o.price)} → </span>
        {fmtPrice(o.pendingPrice)}
      </span>
    );
  }
  return <>{fmtPrice(o.price)}</>;
}

function Size({ o }: { o: QuoterOrder }) {
  return (
    <span title={`total ${o.qty}, filled ${o.executed}`}>
      {fmtQty(o.leaves)}
      {Number(o.executed) > 0 && <span className="text-faint"> ({fmtQty(o.executed)} filled)</span>}
      <Dollars qty={o.leaves} price={o.pendingPrice ?? o.price} />
    </span>
  );
}

function TargetSize({ t }: { t: QuoterTarget }) {
  return (
    <span className="text-faint">
      {fmtQty(t.qty)}
      <Dollars qty={t.qty} price={t.price} />
    </span>
  );
}

// The size's value at its price, stacked under it: the exchange sizes orders in the base asset,
// but a dollar figure is what most people reason in.
function Dollars({ qty, price }: { qty: string; price: string }) {
  const v = Number(qty) * Number(price);
  if (!Number.isFinite(v) || v <= 0) return null;
  return <span className="block text-[10px] leading-tight text-faint">{fmtUsd(v)}</span>;
}

// ---------- parameters ----------

function ParamsPanel({ symbol, s }: { symbol: string; s: QuoterStatus }) {
  const { data } = useQuoterParams(symbol);
  const update = useUpdateQuoterParams();
  const [draft, setDraft] = useState<Record<string, string>>({});

  // The form starts from (and resets to) what the quoter is running with.
  const current = useMemo(() => Object.fromEntries(Object.entries(data?.params ?? {}).map(([k, v]) => [k, String(v)])), [data]);
  useEffect(() => setDraft(current), [current]);

  if (!data)
    return (
      <Panel title="Parameters" className="h-full">
        <Empty>Loading…</Empty>
      </Panel>
    );

  const { baseSymbol: base, quoteSymbol: quote } = s.market;
  const unitSpec = data.schema.find((spec) => spec.key === "sizeUnit");
  const sizeUnit = draft.sizeUnit === "quote" ? "quote" : "base";
  const mid = Number(s.reference?.mid ?? 0);
  // A size field's unit follows the switch; "quote" is the quote currency; the rest are fixed.
  const unitLabel = (spec: QuoterParamSpec) => (spec.unit === "size" ? (sizeUnit === "quote" ? quote : base) : spec.unit === "quote" ? quote : spec.unit);
  const fields = data.schema.filter((spec) => spec.type !== "choice");

  const errors: Record<string, string> = {};
  for (const spec of fields) {
    const err = validate(spec, draft[spec.key] ?? "");
    if (err) errors[spec.key] = err;
  }
  const changed = data.schema.filter((spec) => (draft[spec.key] ?? "") !== current[spec.key]);
  const canApply = changed.length > 0 && changed.every((spec) => !errors[spec.key]) && !update.isPending;

  const apply = () => {
    const patch: QuoterParams = {};
    for (const spec of changed) patch[spec.key] = spec.type === "decimal" || spec.type === "choice" ? draft[spec.key]!.trim() : Number(draft[spec.key]);
    update.mutate({ symbol, patch });
  };

  // Switching units converts every size at the reference price, so the book means the same thing
  // in the new unit. Nothing changes on the quoter until Apply.
  const switchUnit = (to: "base" | "quote") => {
    if (to === sizeUnit || !(mid > 0)) return;
    setDraft((d) => {
      const next: Record<string, string> = { ...d, sizeUnit: to };
      for (const spec of fields) if (spec.unit === "size") next[spec.key] = convertSize(d[spec.key] ?? "", mid, to);
      return next;
    });
  };

  return (
    <Panel
      className="h-full"
      title="Parameters"
      actions={
        <>
          <Button size="xs" tone="ghost" disabled={!changed.length} onClick={() => setDraft(current)} title="Back to what the quoter is running with">
            <RotateCcw size={12} /> Reset
          </Button>
          <Button size="xs" tone="primary" disabled={!canApply} onClick={apply}>
            Apply
            {changed.length ? ` ${changed.length} change${changed.length === 1 ? "" : "s"}` : ""}
          </Button>
        </>
      }
    >
      <div className="h-full overflow-y-auto">
        {unitSpec && (
          <div className="flex items-center gap-3 border-b border-line px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className={cx("block text-xs font-medium", draft.sizeUnit !== current.sizeUnit && "text-info")}>Sizes in</span>
              <span className="block text-[11px] leading-snug text-faint">
                {sizeUnit === "quote"
                  ? `Quote size, max position change and max base to use are in ${quote}, converted to ${base} at the reference price every cycle.`
                  : `Quote size, max position change and max base to use are in ${base}.`}{" "}
                Switching converts them at the current price.
              </span>
            </span>
            <div className="flex shrink-0 rounded border border-line p-0.5" role="radiogroup" aria-label="Sizes in">
              {(["base", "quote"] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  role="radio"
                  aria-checked={sizeUnit === u}
                  disabled={!(mid > 0)}
                  title={mid > 0 ? undefined : "waiting for the reference price to convert"}
                  onClick={() => switchUnit(u)}
                  className={cx("rounded px-2 py-0.5 text-[11px] font-semibold", sizeUnit === u ? "bg-raised text-ink" : "text-muted hover:text-ink")}
                >
                  {u === "base" ? base : quote}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="divide-y divide-line/60">
          {fields.map((spec) => {
            const dirty = (draft[spec.key] ?? "") !== current[spec.key];
            const unit = unitLabel(spec);
            return (
              <label key={spec.key} className="grid grid-cols-[minmax(0,1fr)_9rem] items-center gap-3 px-3 py-2">
                <span className="min-w-0">
                  <span className={cx("block text-xs font-medium", dirty && "text-info")}>
                    {spec.label}
                    {unit && <span className="ml-1 font-normal text-faint">{unit}</span>}
                  </span>
                  <span className="block text-[11px] leading-snug text-faint">{spec.help}</span>
                  {errors[spec.key] && <span className="block text-[11px] text-sell">{errors[spec.key]}</span>}
                </span>
                <input
                  className={cx(inputClass, "text-right", dirty && "border-info", errors[spec.key] && "border-sell")}
                  inputMode="decimal"
                  value={draft[spec.key] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [spec.key]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && canApply && apply()}
                />
              </label>
            );
          })}
        </div>
        <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-faint">
          Changes apply to this book on its next cycle. The quoter saves them to its books file, so they're still there after a restart.
        </p>
      </div>
    </Panel>
  );
}

// convertSize turns a size between the base asset and the quote currency at price. Quote amounts
// round to cents; base amounts keep four significant figures, which is finer than any lot.
export function convertSize(raw: string, price: number, to: "base" | "quote"): string {
  const v = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(v) || !(price > 0)) return raw;
  if (v === 0) return "0";
  if (to === "quote") return String(Math.round(v * price * 100) / 100);
  return String(Number((v / price).toPrecision(4)));
}

// The quoter checks again and has the last word; this just catches typos before a round trip.
export function validate(spec: QuoterParamSpec, raw: string): string | undefined {
  if (spec.type === "choice") return spec.options?.includes(raw) ? undefined : `one of ${spec.options?.join(", ")}`;
  const v = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(v)) return "enter a number";
  const n = Number(v);
  if (spec.type === "integer" && !Number.isInteger(n)) return "enter a whole number";
  if (spec.min !== undefined && n < spec.min) return `at least ${spec.min}`;
  if (spec.max !== undefined && n > spec.max) return `at most ${spec.max}`;
  return undefined;
}

// ---------- events ----------

function EventsPanel({ s }: { s: QuoterStatus }) {
  const tone: Record<string, string> = {
    fill: "text-buy",
    reject: "text-sell",
    warn: "text-accent",
    param: "text-info",
    info: "text-muted",
  };
  const events = [...s.events].reverse().slice(0, 100);
  return (
    <Panel title="Events" className="h-full">
      <div className="h-full overflow-y-auto px-3 py-1.5">
        {events.length === 0 && <Empty>No events yet</Empty>}
        {events.map((e, i) => (
          <div key={`${e.time}-${i}`} className="flex gap-3 py-0.5 text-xs">
            <span className="num shrink-0 text-faint">{new Date(e.time).toLocaleTimeString()}</span>
            <span className={cx("w-12 shrink-0 text-[10px] font-semibold uppercase tracking-wide", tone[e.kind])}>{e.kind}</span>
            <span className="min-w-0 break-words">{e.message}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
