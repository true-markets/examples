import { ChartColumn, ChevronDown, ChevronUp, CircleAlert, CircleHelp, Play, Plus, RotateCcw, SlidersHorizontal, Square, Trash2 } from "lucide-react";
import { createContext, Fragment, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Panel as Pane } from "react-resizable-panels";
import { Divider, pane, Split } from "./Layout.tsx";
import type {
  QuoterBookSummary,
  QuoterDeskStatus,
  QuoterTakeSide,
  QuoterTrade,
  QuoterTradeSummary,
  QuoterOrder,
  QuoterParamSpec,
  QuoterParams,
  QuoterStatus,
  QuoterTarget,
} from "../../../shared/api.ts";
import {
  useAddQuoterBook,
  useQuoterTrades,
  useQuoterBook,
  useQuoterControl,
  useQuoterParams,
  useQuoterStatus,
  useRemoveQuoterBook,
  useSession,
  useResetQuoterPosition,
  useSetQuoterReference,
  useUpdateQuoterParams,
} from "../api.ts";
import { describeBlend, describeSource, ReferenceEditor } from "./ReferenceEditor.tsx";
import { createColumnHelper, type ColumnDef, type ColumnFiltersState } from "@tanstack/react-table";
import { DataTable, type ColMeta } from "../table/DataTable.tsx";
import { useUi } from "../ui-state.tsx";
import { BulkParams } from "./BulkParams.tsx";
import { Stack } from "./Balances.tsx";
import { price as fmtPrice, qty as fmtQty, quoteUnit, usd as fmtUsd } from "../format.ts";
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
  // The instrument is shared with the trading view: picking a book here selects it there, and an
  // instrument picked there shows here when the quoter runs a book for it.
  const { symbol: shared, setSymbol } = useUi();
  const [picked, setPicked] = useState<string>();
  const [help, setHelp] = useHelpSetting();
  // At most one breakdown open at a time; it takes the screen below the bars in place of the books.
  const [open, setOpen] = useStoredChoice<"none" | "edge" | "params">("cefi-console:quoter-breakdown", "none", ["none", "edge", "params"]);
  const books = desk?.books ?? [];
  const has = (s: string | undefined) => !!s && books.some((b) => b.market.symbol === s);
  // The shared instrument if it's a book; else the last book picked here, or the first one.
  const selected = has(shared) ? shared : has(picked) ? picked : books[0]?.market.symbol;
  // Picking a book shows it, closing any breakdown.
  const select = (s: string) => {
    setPicked(s);
    setSymbol(s);
    setOpen("none");
  };
  // On this screen the header's buttons follow the book shown, so an instrument without a book
  // gives way to the one that is.
  useEffect(() => {
    if (selected && selected !== shared) setSymbol(selected);
  }, [shared, selected, setSymbol]);

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
  // With no books there's nothing to break down.
  const shownOpen = desk.books.length ? open : "none";

  // Books and balances run the full height on the left and always show. On the right: the two
  // summary bars, then the selected book, or the breakdown one of the bars opened in its place.
  return (
    <ShowHelp.Provider value={help}>
      <div className="flex h-full min-h-0 flex-col gap-2">
        <DeskBar d={desk} stale={!!status.error} help={help} onHelp={setHelp} />
        <Warnings list={desk.warnings} />
        <div className="min-h-0 flex-1">
          <Split id="quoter" orientation="horizontal">
            <Pane id="quoter-left" defaultSize="28" minSize={300}>
              <Split id="quoter-left" orientation="vertical">
                <Pane id="quoter-books" defaultSize="55" minSize={120}>
                  <div className={pane}>
                    <BooksPanel d={desk} selected={shownOpen === "none" ? selected : undefined} onSelect={select} />
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
            <Pane id="quoter-book" defaultSize="72" minSize="40">
              <div className={cx(pane, "flex flex-col gap-2")}>
                <AllBooksBar d={desk} open={shownOpen === "edge"} onToggle={(o) => setOpen(o ? "edge" : "none")} />
                <ActivityBar d={desk} open={shownOpen === "params"} onToggle={(o) => setOpen(o ? "params" : "none")} />
                {shownOpen === "edge" && (
                  <div className="min-h-0 flex-1">
                    <TradesView />
                  </div>
                )}
                {shownOpen === "params" && (
                  <div className="min-h-0 flex-1">
                    <BulkParams d={desk} />
                  </div>
                )}
                {/* Hidden, not unmounted, under a breakdown: closing it brings the book back as it was. */}
                <div className={cx("min-h-0 flex-1", shownOpen !== "none" && "hidden")}>
                  {selected ? (
                    <BookView key={selected} symbol={selected} live={desk.environment === "production"} paper={desk.mode === "paper"} />
                  ) : (
                    <Panel title="No books yet" className="h-full">
                      <Empty>Add a book on the left. It starts stopped, with a preview of what it would quote, until you start it.</Empty>
                    </Panel>
                  )}
                </div>
              </div>
            </Pane>
          </Split>
        </div>
      </div>
    </ShowHelp.Provider>
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

// ---------- help text ----------

// The explanations under parameters and panels are for learning the quoter; once you know it, the
// Help switch in the Quoter bar hides them. The choice is kept per browser. Tooltips stay.
const ShowHelp = createContext(true);
const helpKey = "cefi-console:quoter-help";

function useHelpSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(helpKey) !== "off";
    } catch {
      return true;
    }
  });
  const set = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(helpKey, v ? "on" : "off");
    } catch {
      // not remembered
    }
  };
  return [on, set];
}

// A choice kept per browser, like the Help switch.
function useStoredChoice<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const got = localStorage.getItem(key) as T | null;
      return got && allowed.includes(got) ? got : fallback;
    } catch {
      return fallback;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      // not remembered
    }
  };
  return [v, set];
}

function Help({ children }: { children: ReactNode }) {
  return useContext(ShowHelp) ? <>{children}</> : null;
}

// "BTC-USD" is a Coinbase product, "hyperliquid:xyz:GOOGL" a Hyperliquid perp, "kraken:GOOGLx/USD" a
// Kraken pair.
export const describeReference = describeSource;

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

function DeskBar({ d, stale, help, onHelp }: { d: QuoterDeskStatus; stale: boolean; help: boolean; onHelp: (on: boolean) => void }) {
  const control = useQuoterControl();
  const [confirm, setConfirm] = useState(false);
  const live = d.environment === "production";
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
      {/* Next to the connections, well away from Stop all. */}
      <Button
        size="xs"
        tone="ghost"
        aria-pressed={help}
        onClick={() => onHelp(!help)}
        title={help ? "Hide the explanations under parameters and panels" : "Show the explanations under parameters and panels"}
      >
        <CircleHelp size={12} className={help ? "text-info" : undefined} /> Help {help ? "on" : "off"}
      </Button>
      {stale && <span className="text-[11px] text-sell">· lost contact with the quoter, showing the last status</span>}
      <div className="ml-auto flex items-center gap-2">
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
  const quoting = d.books.filter((b) => b.state === "quoting").length;
  const orders = d.books.reduce((n, b) => n + b.orders, 0);
  return (
    <Panel
      title="Books"
      className="h-full"
      actions={
        d.books.length > 0 && (
          <span className="num text-[11px] text-muted" title="Books quoting now, and the orders they have resting">
            <span className={quoting === d.books.length ? "text-ink" : "text-accent"}>
              {quoting}/{d.books.length}
            </span>{" "}
            quoting · <span className="text-ink">{orders}</span> orders
          </span>
        )
      }
    >
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
        <span title={b.reference ? `at the reference, ${fmtPrice(b.reference)}` : "no reference price yet"}>
          pos {signed(b.position, 6)} {b.market.baseSymbol}
          {b.reference && Number(b.position) !== 0 && <span className="text-faint"> · {signedUsd(Number(b.position) * Number(b.reference))}</span>}
        </span>
        <span className="ml-auto">PnL {signedUsd(pnl)}</span>
      </div>
      <div className="num mt-1 flex items-center gap-3 text-[11px] text-muted">
        <span title={`The bids hold ${fmtQty(b.heldQuote, 2)} of ${fmtQty(b.budgetQuote, 2)} ${b.market.quoteSymbol}`}>
          {b.market.quoteSymbol}
          <BudgetUse held={b.heldQuote} budget={b.budgetQuote} />
        </span>
        <span title={`The asks hold ${fmtQty(b.heldBase, 4)} of ${fmtQty(b.budgetBase, 4)} ${b.market.baseSymbol}`}>
          {b.market.baseSymbol}
          <BudgetUse held={b.heldBase} budget={b.budgetBase} />
        </span>
      </div>
      {b.reason && b.state === "waiting" && <div className="mt-0.5 truncate text-[11px] text-accent">{b.reason}</div>}
    </button>
  );
}

function AddBook({ d, onAdded }: { d: QuoterDeskStatus; onAdded: (s: string) => void }) {
  const add = useAddQuoterBook();
  const [symbol, setSymbol] = useState("");
  const [editing, setEditing] = useState(false);
  const listing = d.available.find((l) => l.symbol === symbol);
  if (d.available.length === 0) return null;
  return (
    <form
      className="space-y-1.5 border-t border-line px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (symbol) setEditing(true);
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
          <Plus size={12} /> Add…
        </Button>
      </div>
      <Help>{listing && <p className="text-[11px] text-faint">Next: choose its reference price sources, with a live preview.</p>}</Help>
      {editing && listing && (
        <ReferenceEditor
          symbol={listing.symbol}
          fallbackRef={listing.reference}
          title={`Add ${listing.symbol}: reference price`}
          saveLabel="Add book"
          saving={add.isPending}
          onClose={() => setEditing(false)}
          onSave={(blend) =>
            add.mutate(
              { symbol: listing.symbol, blend },
              {
                onSuccess: () => {
                  setEditing(false);
                  onAdded(listing.symbol);
                  setSymbol("");
                },
              },
            )
          }
        />
      )}
    </form>
  );
}

// One row of the shared ledger, with each amount's USD value worked out for sorting and filtering.
interface LedgerRow {
  assetId: string;
  symbol: string;
  price: number | null;
  qty: Record<LedgerCol, number>;
  usd: Record<LedgerCol, number | null>;
}
type LedgerCol = "balance" | "trading" | "other" | "unused";

const ledgerCols: { id: LedgerCol; field: "spendable" | "ourHold" | "foreignHold" | "free"; label: string; title: string }[] = [
  {
    id: "balance",
    field: "spendable",
    label: "Balance",
    title: "Your CeFi balance the quoter can use: less transfer holds and anything leaving at settlement, less fills since the last read",
  },
  { id: "trading", field: "ourHold", label: "Trading", title: "Held right now by the quoter's own orders, across every book" },
  {
    id: "other",
    field: "foreignHold",
    label: "Other orders",
    title: "Held by orders the quoter didn't place: ones you placed in the console or the app, or another program on the same account",
  },
  { id: "unused", field: "free", label: "Unused", title: "Balance less everything held: what any book can still put into a new order" },
];

const ledgerHelper = createColumnHelper<LedgerRow>();

function SharedBalancesPanel({ d }: { d: QuoterDeskStatus }) {
  const [filters, setFilters] = useState<ColumnFiltersState>([]);
  const rows = useMemo<LedgerRow[]>(
    () =>
      d.balances.map((a) => {
        const price = a.price ? Number(a.price) : null;
        const qty = {} as Record<LedgerCol, number>;
        const usd = {} as Record<LedgerCol, number | null>;
        for (const c of ledgerCols) {
          qty[c.id] = Number(a[c.field]);
          usd[c.id] = price === null ? null : qty[c.id] * price;
        }
        return { assetId: a.assetId, symbol: a.symbol || a.assetId, price, qty, usd };
      }),
    [d.balances],
  );
  // Other orders only shows when something else on the account is holding funds.
  const showOther = rows.some((r) => r.qty.other !== 0);
  const columns = useMemo(
    () => [
      ledgerHelper.accessor("symbol", {
        id: "symbol",
        header: "Asset",
        size: 72,
        meta: { label: "Asset", filter: { kind: "multi" } } satisfies ColMeta,
        cell: (c) => (
          <div className="leading-tight">
            <div className="font-semibold text-ink">{c.getValue()}</div>
            <div className="num text-[10px] text-faint">{c.row.original.price !== null ? `$${fmtPrice(c.row.original.price)}` : "no book prices it"}</div>
          </div>
        ),
      }),
      ...ledgerCols
        .filter((col) => col.id !== "other" || showOther)
        .map((col) =>
          ledgerHelper.accessor((r) => r.usd[col.id], {
            id: col.id,
            header: col.label,
            size: 104, // room for the sort arrow and filter button
            sortingFn: (a, b) => (a.getValue<number | null>(col.id) ?? -Infinity) - (b.getValue<number | null>(col.id) ?? -Infinity),
            meta: {
              label: col.label,
              align: "right",
              title: `${col.title}. USD on top, quantity below`,
              filter: { kind: "range", unit: "$" },
            } satisfies ColMeta,
            cell: (c) => {
              const r = c.row.original;
              const q = r.qty[col.id];
              const v = c.getValue();
              return (
                <Stack
                  top={v === null ? "—" : fmtUsd(v)}
                  topClass={q === 0 ? "text-muted" : undefined}
                  bottom={`${fmtQty(q)} ${r.symbol}`}
                  strong={col.id === "unused"}
                />
              );
            },
          }),
        ),
    ],
    [showOther],
  );
  const facets = useMemo(() => ({ symbol: rows.map((r) => ({ value: r.symbol, count: 1 })) }), [rows]);
  const total = (k: LedgerCol) => rows.reduce((s, r) => s + (r.usd[k] ?? 0), 0);
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Shared balances
          {rows.some((r) => r.price !== null) && (
            <span className="num rounded bg-raised px-1.5 py-0.5 text-[11px] font-medium tracking-normal text-ink normal-case" title="Balance, in USD">
              {fmtUsd(total("balance"))}
            </span>
          )}
        </span>
      }
      className="h-full"
    >
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <DataTable<LedgerRow>
            id="quoter-ledger"
            data={rows}
            columns={columns as ColumnDef<LedgerRow, unknown>[]}
            getRowId={(r) => r.assetId}
            defaultSorting={[{ id: "balance", desc: true }]}
            filters={filters}
            onFiltersChange={setFilters}
            facets={facets}
            toolbar={
              <span className="num flex flex-wrap gap-x-3 text-[11px] text-muted">
                <span>
                  Trading <span className="text-ink">{fmtUsd(total("trading"))}</span>
                </span>
                {showOther && (
                  <span>
                    Other orders <span className="text-ink">{fmtUsd(total("other"))}</span>
                  </span>
                )}
                <span>
                  Unused <span className="text-ink">{fmtUsd(total("unused"))}</span>
                </span>
              </span>
            }
            empty="Balances not read yet."
          />
        </div>
        <Help>
          <p className="shrink-0 border-t border-line px-3 py-2 text-[11px] leading-relaxed text-faint">
            One ledger for every book. <b>Balance</b> is your CeFi balance; <b>Trading</b> is what the quoter's orders hold; <b>Unused</b> is what's left for
            new orders
            {showOther ? "; Other orders is held by orders the quoter didn't place" : ""}. A book takes funds from it before each new order or modify, so two
            books never spend the same balance. Read {d.balancesReadAt ? new Date(d.balancesReadAt).toLocaleTimeString() : "not yet"}; between reads it follows
            the books' own orders and fills live.
          </p>
        </Help>
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
              {/* The cards fill the pane and scroll inside, so they tile with the panes below and keep
                  their height whichever tab shows. Drag the divider to give them more room. */}
              <div
                className="grid h-full gap-2"
                style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${CARD_MIN}px, 1fr))`, gridAutoRows: "minmax(120px, 1fr)" }}
              >
                <CardPair
                  id="prices"
                  cards={[
                    { key: "prices", label: "Prices", node: <PricesCard s={s} paper={paper} /> },
                    { key: "reference", label: "Reference", node: <ReferenceCard s={s} /> },
                  ]}
                />
                <CardPair
                  id="position"
                  cards={[
                    { key: "position", label: "Position", node: <PositionCard s={s} /> },
                    { key: "taking", label: "Taking", node: <TakingCard s={s} /> },
                  ]}
                />
                <CardPair
                  id="budget"
                  cards={[
                    { key: "budget", label: "Budget", node: <BalancesCard s={s} /> },
                    { key: "activity", label: "Activity", node: <ActivityCard s={s} /> },
                  ]}
                />
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
      <span className="text-[11px] text-muted">reference {describeBlend(s.market.blend, s.market.reference)}</span>
      <div className="ml-auto flex items-center gap-2">
        {!s.enabled && s.orders.length === 0 && (
          <Button tone="ghost" size="xs" disabled={remove.isPending} onClick={() => remove.mutate(symbol)} title="Stop managing this book">
            <Trash2 size={12} /> Remove
          </Button>
        )}
        {/* Stopping is up in the header, next to the cancel buttons. */}
        {!s.enabled && (
          <Button tone="primary" disabled={control.isPending} onClick={() => (live ? setConfirm(true) : control.mutate({ action: "start", symbol }))}>
            <Play size={12} /> Start quoting
          </Button>
        )}
      </div>
      {confirm && (
        <ConfirmStart
          title={`Start quoting ${symbol}?`}
          body={`The quoter will place and keep moving real post-only orders on the production exchange, using up to $${fmtQty(s.balances.budgetQuote, 2)} of ${s.market.quoteSymbol} and ${fmtQty(s.balances.budgetBase)} ${s.market.baseSymbol}. The ladder below shows what it will quote first. Stop pulls every order.`}
          onClose={() => setConfirm(false)}
          onConfirm={() => control.mutate({ action: "start", symbol })}
        />
      )}
    </section>
  );
}

// ---------- cards ----------

// The narrowest a card reads well. A pair of cards needs two of these side by side, or it shows one
// at a time behind tabs.
const CARD_MIN = 280;

// Set by a pair of cards showing one at a time: the card's header shows the pair's tabs in place
// of its title.
const CardTabs = createContext<{ tabs: { key: string; label: string }[]; active: string; onSelect: (key: string) => void } | null>(null);

function Card({ title, children, action, plain }: { title: ReactNode; children: React.ReactNode; action?: ReactNode; plain?: boolean }) {
  const tabs = useContext(CardTabs);
  return (
    <section className="flex h-full min-h-0 flex-col rounded-md border border-line bg-panel">
      <h2 className="flex min-h-5 shrink-0 items-center px-3 pt-2 pb-1.5 gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
        {tabs ? (
          <span role="tablist" className="-ml-1.5 flex gap-0.5">
            {tabs.tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={t.key === tabs.active}
                onClick={() => tabs.onSelect(t.key)}
                className={cx("rounded px-1.5 py-0.5 uppercase tracking-wider", t.key === tabs.active ? "bg-raised text-ink" : "text-faint hover:text-ink")}
              >
                {t.label}
              </button>
            ))}
          </span>
        ) : (
          title
        )}
        {action && <span className="ml-auto normal-case tracking-normal">{action}</span>}
      </h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {plain ? <div className="text-xs">{children}</div> : <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">{children}</dl>}
      </div>
    </section>
  );
}

// Two related cards: side by side when there's room for both, otherwise one at a time with tabs in
// its header. Each pair measures its own width, so the panel can be any size; the tab you pick is
// remembered.
function CardPair({ id, cards }: { id: string; cards: { key: string; label: string; node: ReactNode }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWide(e!.contentRect.width >= 2 * CARD_MIN + 8));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const keys = cards.map((c) => c.key);
  const [active, setActive] = useStoredChoice(`cefi-console:quoter-cards-${id}`, keys[0]!, keys);
  // One element measured in both modes, so switching never loses the observer.
  return (
    <div ref={ref} className={cx("h-full min-h-0", wide && "grid grid-cols-2 gap-2")}>
      {wide ? (
        cards.map((c) => <Fragment key={c.key}>{c.node}</Fragment>)
      ) : (
        <CardTabs.Provider value={{ tabs: cards.map(({ key, label }) => ({ key, label })), active, onSelect: setActive }}>
          {cards.find((c) => c.key === active)?.node}
        </CardTabs.Provider>
      )}
    </div>
  );
}

function Row({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <>
      <dt className="whitespace-nowrap text-muted" title={title}>
        {label}
      </dt>
      <dd className="num whitespace-nowrap text-right">{children}</dd>
    </>
  );
}

function signedUsd(v: number) {
  if (Math.abs(v) < 0.005) v = 0; // no "−$0.00"
  return <span className={v > 0 ? "text-buy" : v < 0 ? "text-sell" : ""}>{(v > 0 ? "+" : v < 0 ? "−" : "") + fmtUsd(Math.abs(v))}</span>;
}

function signed(v: string | number, decimals = 2) {
  const n = Number(v);
  return <span className={n > 0 ? "text-buy" : n < 0 ? "text-sell" : ""}>{(n > 0 ? "+" : "") + fmtQty(n, decimals)}</span>;
}

function PricesCard({ s, paper }: { s: QuoterStatus; paper: boolean }) {
  const ref = s.reference;
  return (
    <Card title="Prices">
      <Row label="Reference" title={`${describeBlend(s.market.blend, s.market.reference)}; the age is since its price last changed`}>
        {ref ? fmtPrice(ref.mid) : "—"} <span className="text-faint">{ref ? `${(ref.ageMs / 1000).toFixed(1)}s` : ""}</span>
      </Row>
      <Row label="Quoting mid" title="The reference after inventory skew">
        {s.mid ? fmtPrice(s.mid) : "—"}
      </Row>
      <Row label="Skew">{s.skewBps ? `${s.skewBps.toFixed(2)} bps` : "none"}</Row>
      <Row label="Book bid / ask" title={paper ? "The exchange's best bid and ask; in paper mode, the reference's" : "The exchange's best bid and ask"}>
        <span className="text-buy">{s.bestBid ? fmtPrice(s.bestBid) : "—"}</span> / <span className="text-sell">{s.bestAsk ? fmtPrice(s.bestAsk) : "—"}</span>
      </Row>
      <Row label="Bid from mid" title="The book's best bid against the reference mid, in bps and dollars">
        <FromMid price={s.bestBid} mid={ref?.mid} />
      </Row>
      <Row label="Ask from mid" title="The book's best ask against the reference mid, in bps and dollars">
        <FromMid price={s.bestAsk} mid={ref?.mid} />
      </Row>
    </Card>
  );
}

// How far a price sits from the mid: negative below it, positive above.
function FromMid({ price, mid }: { price: string | null | undefined; mid: string | null | undefined }) {
  const p = Number(price);
  const m = Number(mid);
  if (!(p > 0) || !(m > 0)) return <span className="text-faint">—</span>;
  const d = p - m;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "";
  return (
    <>
      {sign}
      {Math.abs((d / m) * 10_000).toFixed(1)} bps <span className="text-faint">· {sign + fmtUsd(Math.abs(d))}</span>
    </>
  );
}

function PositionCard({ s }: { s: QuoterStatus }) {
  const p = s.position;
  const base = s.market.baseSymbol;
  const quote = quoteUnit(s.market.quoteSymbol);
  const max = Number(s.params.maxPosition ?? 0);
  const reset = useResetQuoterPosition();
  const [confirm, setConfirm] = useState(false);
  const since = new Date(p.since);
  return (
    <Card
      title="Position"
      action={
        <Button size="xs" tone="ghost" onClick={() => setConfirm(true)} title="Start this book's position, PnL, volume and counts from zero">
          <RotateCcw size={12} /> Reset
        </Button>
      }
    >
      {confirm && (
        <Modal
          title={`Reset ${s.market.symbol}'s position?`}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>Cancel</Button>
              <Button
                tone="danger"
                onClick={() => {
                  reset.mutate(s.market.symbol);
                  setConfirm(false);
                }}
              >
                Reset to zero
              </Button>
            </>
          }
        >
          <p className="text-xs leading-relaxed text-muted">
            The position ({p.qty} {base}), its average cost, realized PnL, volume and activity counts start again from zero, and the max position change is
            measured from now. Nothing is traded and your balances don't change; the trade journal keeps its history.
          </p>
        </Modal>
      )}
      <Row label="Since" title="When this book's position started counting: its first start, or the last reset. Carried across quoter restarts">
        {since.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      </Row>
      <Row label="Change" title="Bought minus sold since then">
        {signed(p.qty, 6)} {base}
      </Row>
      <Row label="Limit" title="The max position change, each way">
        {max > 0 ? `±${s.params.sizeUnit === "quote" ? fmtUsd(max) : `${fmtQty(max)} ${base}`}` : "off"}
      </Row>
      <Row label="Avg cost">{Number(p.qty) === 0 ? "—" : fmtPrice(p.avgCost)}</Row>
      <Row label="Realized PnL">{signedUsd(Number(p.realizedPnl))}</Row>
      <Row label="Unrealized" title="The open position marked to the reference mid">
        {signedUsd(Number(p.unrealizedPnl))}
      </Row>
      <Row label="Volume" title={`${fmtQty(p.volumeBase)} ${base}`}>
        {fmtUsd(Number(p.volumeQuote))}
      </Row>
    </Card>
  );
}

// How much of a budget the book's orders hold: green, yellow from 75%, red above 90%. Near the
// top, the next order on that side may not fit.
export function budgetTone(pct: number): "ok" | "warn" | "high" {
  return pct > 90 ? "high" : pct >= 75 ? "warn" : "ok";
}

function BudgetUse({ held, budget }: { held: string | undefined; budget: string | undefined }) {
  const h = Number(held);
  const b = Number(budget);
  if (!(b > 0)) return <span className="ml-1 text-faint">—</span>;
  const pct = (h / b) * 100;
  const tone = budgetTone(pct);
  const cls = { ok: "bg-buy-soft text-buy", warn: "bg-accent-soft text-accent", high: "bg-sell-soft text-sell" }[tone];
  return (
    <span
      className={cx("ml-1 inline-block min-w-11 rounded px-1 text-center text-[11px] font-medium", cls)}
      title={tone === "ok" ? "of the budget in use" : tone === "warn" ? "75% or more in use" : "over 90% in use: new orders on this side may not fit"}
    >
      {pct.toFixed(0)}%
    </span>
  );
}

function BalancesCard({ s }: { s: QuoterStatus }) {
  const b = s.balances;
  const base = s.market.baseSymbol;
  const quote = s.market.quoteSymbol;
  return (
    <Card title="Budget">
      <Row
        label={quote}
        title={`${quote} the bids hold now, out of what they may hold: what they hold plus the shared free balance, capped by Max quote to use`}
      >
        {fmtQty(b.heldQuote, 2)} / {fmtQty(b.budgetQuote, 2)} <BudgetUse held={b.heldQuote} budget={b.budgetQuote} />
      </Row>
      <Row label={base} title={`${base} the asks hold now, out of what they may hold`}>
        {fmtQty(b.heldBase, 4)} / {fmtQty(b.budgetBase, 4)} <BudgetUse held={b.heldBase} budget={b.budgetBase} />
      </Row>
      <Row label={`Free ${quote}`} title="Unused in the ledger every book draws on">
        {fmtUsd(Number(b.freeQuote))}
      </Row>
      <Row label={`Free ${base}`} title="Unused in the ledger every book draws on">
        {fmtQty(b.freeBase, 4)}
      </Row>
      <Row label="Read">{b.readAt ? new Date(b.readAt).toLocaleTimeString() : "not yet"}</Row>
    </Card>
  );
}

function ActivityCard({ s }: { s: QuoterStatus }) {
  const st = s.stats;
  return (
    <Card title="Activity">
      <Row label="New / modify / cancel" title="Requests sent">
        {st.creates} / <span className="text-info">{st.modifies}</span> / {st.cancels}
      </Row>
      <Row label="Fills / rejects">
        <span className="text-buy">{st.fills}</span> / <span className={st.rejects ? "text-sell" : ""}>{st.rejects}</span>
        {st.errors > 0 && <span className="text-sell"> · {st.errors} errors</span>}
      </Row>
      <Row label="Takes / filled" title="IOC orders sent to cross the spread (profit taker and takeout), and how many traded">
        {st.takes} / <span className={st.takeFills ? "text-buy" : ""}>{st.takeFills}</span>
      </Row>
      <Row label="Maker share" title="Of the fills, how many were the ladder's resting orders being hit, rather than takes crossing the spread">
        {st.fills ? (
          <>
            {Math.round((100 * (st.fills - st.takeFills)) / st.fills)}%{" "}
            <span className="text-faint">
              · {st.fills - st.takeFills} of {st.fills}
            </span>
          </>
        ) : (
          "—"
        )}
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
    <Panel
      className="h-full"
      title={s.enabled ? "Ladder" : <span title="Stopped: what it would quote once started">Ladder · preview</span>}
      center={<LadderSpread s={s} />}
    >
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
                  <td className="px-2 py-1.5 text-right">{r.bid ? <Size o={r.bid} /> : r.bidTarget ? <TargetSize t={r.bidTarget} /> : null}</td>
                  <td className="px-2 py-1.5 text-right text-buy">{r.bid ? <OrderPrice o={r.bid} /> : "—"}</td>
                  <td className="px-2 py-1.5 text-right text-faint">{r.bidTarget ? fmtPrice(r.bidTarget.price) : ""}</td>
                  <td className="px-2 py-1.5 text-center text-muted">{r.level}</td>
                  <td className="px-2 py-1.5 text-faint">{r.askTarget ? fmtPrice(r.askTarget.price) : ""}</td>
                  <td className="px-2 py-1.5 text-sell">{r.ask ? <OrderPrice o={r.ask} /> : "—"}</td>
                  <td className="px-2 py-1.5">{r.ask ? <Size o={r.ask} /> : r.askTarget ? <TargetSize t={r.askTarget} /> : null}</td>
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
        <Help>
          <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-faint">
            Target is where the strategy wants each order this cycle; Bid and Ask are where the orders rest, with an arrow while a modify is in flight. An order
            only moves once its target is at least the modify threshold away ({s.params.modifyThresholdBps} bps). Size is what is still resting, in{" "}
            {s.market.baseSymbol}, with its value in USD under it.
          </p>
        </Help>
      </div>
    </Panel>
  );
}

// The spread between the ladder's own best bid and best ask: what's resting, or what it would quote
// when nothing rests yet (a stopped book's preview).
function LadderSpread({ s }: { s: QuoterStatus }) {
  const resting = s.orders.filter((o) => !o.take && o.level >= 0);
  const bids = resting.filter((o) => o.side === "BUY").map((o) => Number(o.price));
  const asks = resting.filter((o) => o.side === "SELL").map((o) => Number(o.price));
  const fromTargets = bids.length === 0 && asks.length === 0;
  if (fromTargets) {
    for (const t of s.targets) (t.side === "BUY" ? bids : asks).push(Number(t.price));
  }
  if (bids.length === 0 || asks.length === 0) return null;
  const bid = Math.max(...bids);
  const ask = Math.min(...asks);
  const spread = ask - bid;
  const bps = (spread / ((ask + bid) / 2)) * 10_000;
  return (
    <span
      className="num text-[11px] text-muted"
      title={`${fromTargets ? "What the ladder would quote" : "The ladder's resting best bid and ask"}: ${fmtPrice(bid)} / ${fmtPrice(ask)}`}
    >
      Spread <span className="text-ink">{bps.toFixed(1)} bps</span> · <span className="text-ink">{fmtUsd(spread)}</span>
      {fromTargets && <span className="text-faint"> (target)</span>}
    </span>
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

  const base = s.market.baseSymbol;
  const quote = quoteUnit(s.market.quoteSymbol);
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
    for (const spec of changed)
      patch[spec.key] =
        spec.type === "boolean"
          ? draft[spec.key] === "true"
          : spec.type === "decimal" || spec.type === "choice"
            ? draft[spec.key]!.trim()
            : Number(draft[spec.key]);
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
              <Help>
                <span className="block text-[11px] leading-snug text-faint">
                  {sizeUnit === "quote"
                    ? `Quote size, max position change and max base to use are in ${quote}, converted to ${base} at the reference price every cycle.`
                    : `Quote size, max position change and max base to use are in ${base}.`}{" "}
                  Switching converts them at the current price.
                </span>
              </Help>
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
              <Fragment key={spec.key}>
                {spec.key === "profitTaker" && (
                  <div className="bg-raised/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">Taking</div>
                )}
                <label className="grid grid-cols-[minmax(0,1fr)_9rem] items-center gap-3 px-3 py-2">
                  <span className="min-w-0">
                    <span className={cx("block text-xs font-medium", dirty && "text-info")}>
                      {spec.label}
                      {unit && <span className="ml-1 font-normal text-faint">{unit}</span>}
                    </span>
                    <Help>
                      <span className="block text-[11px] leading-snug text-faint">{spec.help}</span>
                    </Help>
                    {errors[spec.key] && <span className="block text-[11px] text-sell">{errors[spec.key]}</span>}
                  </span>
                  {spec.type === "boolean" ? (
                    <div
                      className={cx("flex justify-self-end rounded border p-0.5", dirty ? "border-info" : "border-line")}
                      role="radiogroup"
                      aria-label={spec.label}
                    >
                      {(["true", "false"] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          role="radio"
                          aria-checked={draft[spec.key] === v}
                          onClick={() => setDraft((d) => ({ ...d, [spec.key]: v }))}
                          className={cx(
                            "rounded px-2 py-0.5 text-[11px] font-semibold",
                            draft[spec.key] === v ? "bg-raised text-ink" : "text-muted hover:text-ink",
                          )}
                        >
                          {v === "true" ? "On" : "Off"}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <input
                      className={cx(inputClass, "text-right", dirty && "border-info", errors[spec.key] && "border-sell")}
                      inputMode="decimal"
                      value={draft[spec.key] ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [spec.key]: e.target.value }))}
                      onKeyDown={(e) => e.key === "Enter" && canApply && apply()}
                    />
                  )}
                </label>
              </Fragment>
            );
          })}
        </div>
        <Help>
          <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-faint">
            Changes apply to this book on its next cycle. The quoter saves them to its books file, so they're still there after a restart.
          </p>
        </Help>
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
  if (spec.type === "boolean") return raw === "true" || raw === "false" ? undefined : "on or off";
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
    take: "text-accent",
    reject: "text-sell",
    warn: "text-accent",
    param: "text-info",
    info: "text-muted",
  };
  const events = [...s.events].reverse().slice(0, 100);
  const { data: session } = useSession();
  const [tab, setTab] = useStoredChoice<"events" | "trades">("cefi-console:quoter-book-pane", "events", ["events", "trades"]);
  const trades = useQuoterTrades(!!session?.quoter);
  const mine = useMemo(() => (trades.data?.trades ?? []).filter((t) => t.symbol === s.market.symbol), [trades.data, s.market.symbol]);
  const count = mine.length;
  const tabs = (
    <span role="tablist" className="-ml-1.5 flex gap-0.5">
      {(["events", "trades"] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          onClick={() => setTab(t)}
          className={cx("rounded px-1.5 py-0.5 uppercase tracking-wider", tab === t ? "bg-raised text-ink" : "text-faint hover:text-ink")}
        >
          {t === "events" ? "Events" : `${s.market.baseSymbol} trades${count ? ` (${count})` : ""}`}
        </button>
      ))}
    </span>
  );
  if (tab === "trades")
    return (
      <Panel title={tabs} className="h-full">
        {trades.data ? (
          <TradesTable id="quoter-book-trades" trades={mine} hz={trades.data.horizonsSecs} />
        ) : (
          <Empty>{trades.error ? trades.error.message : "Loading trades…"}</Empty>
        )}
      </Panel>
    );
  return (
    <Panel title={tabs} className="h-full">
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

// ---------- totals across books ----------

function bps(v: number | null | undefined, digits = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return <span className="text-faint">—</span>;
  return <span className={v > 0 ? "text-buy" : v < 0 ? "text-sell" : ""}>{(v > 0 ? "+" : "") + v.toFixed(digits)}</span>;
}

function pct(v: number | null | undefined) {
  if (v === null || v === undefined || !Number.isFinite(v)) return <span className="text-faint">—</span>;
  return <span className={v >= 0.5 ? "text-buy" : v < 0 ? "text-sell" : "text-accent"}>{Math.round(v * 100)}%</span>;
}

const barLabel = "text-[10px] font-semibold uppercase tracking-wider text-muted";
const barItem = "flex items-baseline gap-1.5";

// A summary bar: a name, its figures on one baseline, and a button on the right that opens what
// sits under it. The button never makes the bar taller.
function SummaryBar({ name, children, button }: { name: string; children: ReactNode; button: ReactNode }) {
  return (
    <section className="num flex items-center gap-3 rounded-md border border-line bg-panel px-3 py-1.5 text-xs">
      <span className={cx(barLabel, "w-[4.5rem] shrink-0")}>{name}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-6 gap-y-1">{children}</div>
      {button}
    </section>
  );
}

function OpenButton({
  open,
  onToggle,
  icon,
  label,
  title,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  icon: ReactNode;
  label: string;
  title: string;
}) {
  return (
    <Button size="xs" tone="ghost" className="-my-1 shrink-0" aria-expanded={open} onClick={() => onToggle(!open)} title={title}>
      {icon} {label} {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
    </Button>
  );
}

// Results across every book; opens every book's edge and every trade.
function AllBooksBar({ d, open, onToggle }: { d: QuoterDeskStatus; open: boolean; onToggle: (open: boolean) => void }) {
  if (!d.books.length) return null;
  const t = d.trades;
  return (
    <SummaryBar
      name="All books"
      button={
        <OpenButton
          open={open}
          onToggle={onToggle}
          icon={<ChartColumn size={12} />}
          label={`Trades${t.trades ? ` (${t.trades})` : ""}`}
          title={open ? "Close trades" : "Edge retention by book, and every trade across the books"}
        />
      }
    >
      {d.totals.map((x) => {
        const pnl = Number(x.realizedPnl) + Number(x.unrealizedPnl);
        return (
          <Fragment key={x.quote}>
            <span className={barItem} title="Realized plus unrealized, since each book's position started counting">
              <span className={barLabel}>PnL</span>
              {signed(pnl)} {quoteUnit(x.quote)}
              <span className="text-faint">
                ({signed(x.realizedPnl)} realized · {signed(x.unrealizedPnl)} open)
              </span>
            </span>
            <span className={barItem}>
              <span className={barLabel}>Volume</span>
              {fmtUsd(Number(x.volumeQuote))}
            </span>
          </Fragment>
        );
      })}
      {t.trades > 0 && (
        <span className={barItem} title="Notional-weighted edge at fill, and what was left of it at each mark-out">
          <span className={barLabel}>Edge</span>
          {bps(t.edgeBps)} at fill
          {t.horizonsSecs.map((h, i) => (
            <span key={h}>
              · {bps(t.markouts[i])} at +{h}s
            </span>
          ))}
          <span className="text-faint">bps</span>
        </span>
      )}
    </SummaryBar>
  );
}

// What every book has been doing; opens the all-books parameter editor.
function ActivityBar({ d, open, onToggle }: { d: QuoterDeskStatus; open: boolean; onToggle: (open: boolean) => void }) {
  if (!d.books.length) return null;
  return (
    <SummaryBar
      name="Activity"
      button={
        <OpenButton
          open={open}
          onToggle={onToggle}
          icon={<SlidersHorizontal size={12} />}
          label="Parameters"
          title={open ? "Close the all-books parameter editor" : "Edit parameters across every book"}
        />
      }
    >
      {d.totals.map((x) => {
        const st = x.stats;
        const maker = st.fills - st.takeFills;
        return (
          <Fragment key={x.quote}>
            <span className={barItem} title="New, modify and cancel requests sent">
              <span className={barLabel}>Requests</span>
              {st.creates} new · <span className="text-info">{st.modifies} modify</span> · {st.cancels} cancel
            </span>
            <span className={barItem}>
              <span className={barLabel}>Fills</span>
              <span className="text-buy">{st.fills}</span>
              <span className="text-faint">· {st.takeFills} from takes</span>
              {st.rejects > 0 && <span className="text-sell">· {st.rejects} rejects</span>}
            </span>
            <span className={barItem} title="Of the fills, how many were the ladders' resting orders being hit, rather than takes crossing the spread">
              <span className={barLabel}>Maker</span>
              {st.fills ? (
                <>
                  {Math.round((100 * maker) / st.fills)}%
                  <span className="text-faint">
                    · {maker} of {st.fills} fills
                  </span>
                </>
              ) : (
                <span className="text-faint">—</span>
              )}
            </span>
          </Fragment>
        );
      })}
    </SummaryBar>
  );
}

// ---------- reference sources ----------

// The book's reference: each source's adjusted price and part in the blend, and anything that
// looks like a corporate action. Edit opens the same editor as adding a book, on this book's blend.
function ReferenceCard({ s }: { s: QuoterStatus }) {
  const [editing, setEditing] = useState(false);
  const save = useSetQuoterReference();
  const v = s.blend;
  const flagged = v?.sources.filter((x) => x.action && x.action.kind !== "drift") ?? [];
  return (
    <Card
      title="Reference sources"
      plain
      action={
        <Button size="xs" tone="ghost" onClick={() => setEditing(true)}>
          Edit…
        </Button>
      }
    >
      <div className="num space-y-0.5">
        {v?.sources.map((x) => (
          <div key={x.ref} className="flex items-baseline gap-2" title={x.note}>
            <span className={cx("truncate", x.state === "in" ? "" : x.state === "out" ? "text-danger" : "text-faint")}>{describeSource(x.ref)}</span>
            <span className="ml-auto">{x.adjusted ? fmtPrice(x.adjusted) : "—"}</span>
            <span className="w-12 text-right text-faint">{x.state === "in" ? `${(x.share * 100).toFixed(0)}%` : x.state}</span>
          </div>
        ))}
        {v && Number(v.tokenMultiplier) !== 1 && <div className="text-[11px] text-faint">× token multiplier {v.tokenMultiplier}</div>}
        {v?.problem && <div className="text-[11px] text-danger">{v.problem}</div>}
        {flagged.map((x) => (
          <div key={x.ref} className="text-[11px] text-accent">
            {describeSource(x.ref)}: {x.action!.kind === "split" ? "likely split" : "out of line"} (try multiplier {x.action!.multiplier})
          </div>
        ))}
      </div>
      {editing && (
        <ReferenceEditor
          symbol={s.market.symbol}
          initial={s.market.blend}
          fallbackRef={s.market.reference}
          title={`${s.market.symbol}: reference price`}
          saveLabel="Save"
          saving={save.isPending}
          onClose={() => setEditing(false)}
          onSave={(blend) => save.mutate({ symbol: s.market.symbol, blend }, { onSuccess: () => setEditing(false) })}
        />
      )}
    </Card>
  );
}

// ---------- take proximity ----------

function TakingCard({ s }: { s: QuoterStatus }) {
  const v = s.taking;
  return (
    <Card title="Taking" plain>
      {!v ? (
        <div className="text-faint">waiting for a price</div>
      ) : (
        <div className="space-y-2">
          <TakeSideRow t={v.sell} base={s.market.baseSymbol} />
          <TakeSideRow t={v.buy} base={s.market.baseSymbol} />
        </div>
      )}
    </Card>
  );
}

// One side: where a take would cross, how much of the edge it needs is on offer now (the bar), and
// what's in the way.
function TakeSideRow({ t, base }: { t: QuoterTakeSide; base: string }) {
  const edge = t.edgeBps;
  const need = t.thresholdBps;
  const away = edge === null ? null : need - edge;
  const fill = edge === null ? 0 : need <= 0 ? (edge >= need ? 1 : 0) : Math.max(0, Math.min(1, edge / need));
  const ready = !t.blocker;
  const valueUsd = t.price ? Number(t.qty) * Number(t.price) : 0;
  return (
    <div className="num text-xs">
      <div className="flex items-baseline gap-2 whitespace-nowrap">
        <span className="text-muted">{t.side === "SELL" ? "Hit bid" : "Lift ask"}</span>
        <span className={cx("text-[10px]", t.enabled ? "text-faint" : "text-faint line-through")} title={t.enabled ? undefined : "off"}>
          {t.kind}
        </span>
        <span className="ml-auto" title={t.price ? `${t.qty} ${base} shown by others` : undefined}>
          {t.price ? (
            <>
              {fmtPrice(t.price)} <span className="text-faint">{fmtUsd(valueUsd)}</span>
            </>
          ) : (
            <span className="text-faint">empty</span>
          )}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised" title={`edge ${edge?.toFixed(1) ?? "—"} of ${need.toFixed(1)} bps needed`}>
          <span className={cx("block h-full rounded-full", ready ? "bg-buy" : fill >= 1 ? "bg-accent" : "bg-info")} style={{ width: `${fill * 100}%` }} />
        </span>
        <span className="whitespace-nowrap text-[11px]">
          {bps(edge)} <span className="text-faint">/ {need.toFixed(1)} bps</span>
        </span>
      </div>
      <div className={cx("mt-0.5 text-[11px]", ready ? "text-buy" : "text-faint")}>
        {ready ? `would take ${fmtQty(t.size)} ${base}` : t.blocker === "no edge" && away !== null ? `${away.toFixed(1)} bps away` : t.blocker}
      </div>
    </div>
  );
}

// ---------- trades ----------

// One fill, with what the table sorts and filters on worked out.
interface TradeRow {
  id: string;
  timeMs: number;
  symbol: string;
  side: string;
  kind: string;
  level: number;
  qty: number;
  price: number;
  notional: number;
  fair: number;
  edge: number;
  markouts: (number | null)[];
  kept: number | null;
}

const tradeHelper = createColumnHelper<TradeRow>();
const summaryHelper = createColumnHelper<QuoterTradeSummary>();
// Sorts nulls (not marked yet) below every number.
const nullsLast = (id: string) => (a: { getValue: <V>(id: string) => V }, b: { getValue: <V>(id: string) => V }) =>
  (a.getValue<number | null>(id) ?? -Infinity) - (b.getValue<number | null>(id) ?? -Infinity);

function TradesView() {
  const { data: session } = useSession();
  const q = useQuoterTrades(!!session?.quoter);
  const r = q.data;
  if (!r) return <Empty>{q.error ? q.error.message : "Loading trades…"}</Empty>;
  return (
    <Split id="quoter-trades" orientation="vertical">
      <Pane id="quoter-trades-summary" defaultSize="32" minSize={120}>
        <div className={pane}>
          <SummaryTable byBook={r.byBook} total={r.total} hz={r.horizonsSecs} />
        </div>
      </Pane>
      <Divider vertical />
      <Pane id="quoter-trades-list" defaultSize="68" minSize={160}>
        <div className={pane}>
          <Panel title={`Trades · all books (${r.total.trades})`} className="h-full">
            <TradesTable id="quoter-trades" trades={r.trades} hz={r.horizonsSecs} />
          </Panel>
        </div>
      </Pane>
    </Split>
  );
}

function SummaryTable({ byBook, total, hz }: { byBook: QuoterTradeSummary[]; total: QuoterTradeSummary; hz: number[] }) {
  const [filters, setFilters] = useState<ColumnFiltersState>([]);
  const lastH = hz[hz.length - 1];
  const columns = useMemo(
    () => [
      summaryHelper.accessor("symbol", {
        id: "symbol",
        header: "Book",
        size: 120,
        meta: { label: "Book", filter: { kind: "multi" } } satisfies ColMeta,
        cell: (c) => <span className="font-medium">{c.getValue()}</span>,
      }),
      summaryHelper.accessor("trades", {
        id: "trades",
        header: "Trades",
        size: 80,
        meta: { label: "Trades", align: "right", filter: { kind: "range" } } satisfies ColMeta,
        cell: (c) => (
          <span
            title={Object.entries(c.row.original.byKind)
              .map(([k, n]) => `${n} ${k}`)
              .join(", ")}
          >
            {c.getValue()}
          </span>
        ),
      }),
      summaryHelper.accessor((b) => Number(b.notional), {
        id: "notional",
        header: "Notional",
        size: 100,
        meta: { label: "Notional", align: "right", filter: { kind: "range", unit: "$" } } satisfies ColMeta,
        cell: (c) => fmtUsd(c.getValue()),
      }),
      summaryHelper.accessor("edgeBps", {
        id: "edge",
        header: "Edge at fill",
        size: 100,
        sortingFn: nullsLast("edge"),
        meta: { label: "Edge at fill", align: "right", title: "Notional-weighted, in bps in our favor", filter: { kind: "range" } } satisfies ColMeta,
        cell: (c) => bps(c.getValue()),
      }),
      ...hz.map((h, i) =>
        summaryHelper.accessor((b) => b.markouts[i] ?? null, {
          id: `m${h}`,
          header: `+${h}s`,
          size: 80,
          sortingFn: nullsLast(`m${h}`),
          meta: {
            label: `Mark-out +${h}s`,
            align: "right",
            title: `Mark-out ${h}s after each fill, notional-weighted, bps`,
            filter: { kind: "range" },
          } satisfies ColMeta,
          cell: (c) => <span title={`${c.row.original.marked[i]} of ${c.row.original.trades} trades marked`}>{bps(c.getValue())}</span>,
        }),
      ),
      ...hz.map((h, i) =>
        summaryHelper.accessor((b) => b.retention[i] ?? null, {
          id: `k${h}`,
          header: `Kept +${h}s`,
          size: 96,
          sortingFn: nullsLast(`k${h}`),
          meta: {
            label: `Kept +${h}s`,
            align: "right",
            title: `Mark-out at +${h}s over edge at fill: 100% kept it all`,
            filter: { kind: "range", scale: 100, unit: "%" },
          } satisfies ColMeta,
          cell: (c) => pct(c.getValue()),
        }),
      ),
      summaryHelper.accessor((b) => b.markedPnl[b.markedPnl.length - 1] ?? null, {
        id: "pnl",
        header: `PnL +${lastH}s`,
        size: 100,
        sortingFn: nullsLast("pnl"),
        meta: {
          label: `PnL +${lastH}s`,
          align: "right",
          title: `Mark-out at +${lastH}s in dollars, summed`,
          filter: { kind: "range", unit: "$" },
        } satisfies ColMeta,
        cell: (c) => {
          const v = c.getValue();
          return v === null ? <span className="text-faint">—</span> : signedUsd(v);
        },
      }),
    ],
    [hz, lastH],
  );
  const facets = useMemo(() => ({ symbol: byBook.map((b) => ({ value: b.symbol, count: b.trades })) }), [byBook]);
  const totalPnl = total.markedPnl[total.markedPnl.length - 1];
  const totalKept = total.retention[total.retention.length - 1];
  return (
    <Panel title="Edge retention by book" className="h-full">
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <DataTable<QuoterTradeSummary>
            id="quoter-trade-summary"
            data={byBook}
            columns={columns as ColumnDef<QuoterTradeSummary, unknown>[]}
            getRowId={(b) => b.symbol}
            defaultSorting={[{ id: "notional", desc: true }]}
            filters={filters}
            onFiltersChange={setFilters}
            facets={facets}
            toolbar={
              <span className="num flex flex-wrap gap-x-3 text-[11px] text-muted">
                <span className="font-semibold text-ink">All books</span>
                <span>
                  <span className="text-ink">{total.trades}</span> trades
                </span>
                <span>
                  <span className="text-ink">{fmtUsd(Number(total.notional))}</span> notional
                </span>
                <span>edge {bps(total.edgeBps)} bps</span>
                <span>
                  kept +{lastH}s {pct(totalKept)}
                </span>
                <span>
                  PnL +{lastH}s {totalPnl === null || totalPnl === undefined ? <span className="text-faint">—</span> : signedUsd(totalPnl)}
                </span>
              </span>
            }
            empty="No fills yet this run"
          />
        </div>
        <Help>
          <p className="shrink-0 border-t border-line px-3 py-2 text-[11px] leading-relaxed text-faint">
            Edge at fill is how far each fill was from fair value (the reference mid) in your favor. The mark-outs measure the same thing {hz.join(" and ")}{" "}
            seconds later. A maker gets filled exactly when the market moves through its quote, so the mid often keeps going: a fill that looked good can mark
            out at a loss. Kept is the mark-out over the edge at fill. 100% means the edge held, below 0 means the market took it all and more. That loss is
            adverse selection, and it's what your spread has to pay for.
          </p>
        </Help>
      </div>
    </Panel>
  );
}

function TradesTable({ id, trades, hz }: { id: string; trades: QuoterTrade[]; hz: number[] }) {
  const [filters, setFilters] = useState<ColumnFiltersState>([]);
  const rows = useMemo<TradeRow[]>(
    () =>
      trades.map((t) => {
        const last = t.markouts[t.markouts.length - 1];
        return {
          id: String(t.id),
          timeMs: Date.parse(t.time),
          symbol: t.symbol,
          side: t.side,
          kind: t.kind,
          level: t.level,
          qty: Number(t.qty),
          price: Number(t.price),
          notional: Number(t.notional),
          fair: Number(t.refMid),
          edge: t.edgeBps,
          markouts: t.markouts,
          kept: last !== null && last !== undefined && t.edgeBps > 0 ? last / t.edgeBps : null,
        };
      }),
    [trades],
  );
  const columns = useMemo(
    () => [
      tradeHelper.accessor("timeMs", {
        id: "time",
        header: "Time",
        size: 96,
        meta: { label: "Time", filter: { kind: "since" } } satisfies ColMeta,
        cell: (c) => <span className="text-faint">{new Date(c.getValue()).toLocaleTimeString()}</span>,
      }),
      tradeHelper.accessor("symbol", {
        id: "symbol",
        header: "Book",
        size: 116,
        meta: { label: "Book", filter: { kind: "multi" } } satisfies ColMeta,
        cell: (c) => <span className="font-medium">{c.getValue()}</span>,
      }),
      tradeHelper.accessor("side", {
        id: "side",
        header: "Side",
        size: 64,
        meta: { label: "Side", filter: { kind: "multi" } } satisfies ColMeta,
        cell: (c) => <span className={c.getValue() === "BUY" ? "text-buy" : "text-sell"}>{c.getValue()}</span>,
      }),
      tradeHelper.accessor("kind", {
        id: "kind",
        header: "Kind",
        size: 96,
        meta: { label: "Kind", title: "maker (with its ladder level), profit take or takeout", filter: { kind: "multi" } } satisfies ColMeta,
        cell: (c) => {
          const t = c.row.original;
          return <span className={t.kind === "maker" ? "text-muted" : "text-accent"}>{t.kind === "maker" ? `maker L${t.level}` : t.kind}</span>;
        },
      }),
      tradeHelper.accessor("qty", {
        id: "qty",
        header: "Qty",
        size: 96,
        meta: { label: "Qty", align: "right", filter: { kind: "range" } } satisfies ColMeta,
        cell: (c) => fmtQty(c.getValue()),
      }),
      tradeHelper.accessor("price", {
        id: "price",
        header: "Price",
        size: 96,
        meta: { label: "Price", align: "right", filter: { kind: "range" } } satisfies ColMeta,
        cell: (c) => fmtPrice(c.getValue()),
      }),
      tradeHelper.accessor("notional", {
        id: "notional",
        header: "Notional",
        size: 96,
        meta: { label: "Notional", align: "right", filter: { kind: "range", unit: "$" } } satisfies ColMeta,
        cell: (c) => fmtUsd(c.getValue()),
      }),
      tradeHelper.accessor("fair", {
        id: "fair",
        header: "Fair",
        size: 96,
        meta: { label: "Fair", align: "right", title: "The reference mid at the fill", filter: { kind: "range" } } satisfies ColMeta,
        cell: (c) => <span className="text-faint">{fmtPrice(c.getValue())}</span>,
      }),
      tradeHelper.accessor("edge", {
        id: "edge",
        header: "Edge",
        size: 76,
        meta: { label: "Edge", align: "right", title: "bps from fair value in our favor, at the fill", filter: { kind: "range" } } satisfies ColMeta,
        cell: (c) => bps(c.getValue()),
      }),
      ...hz.map((h, i) =>
        tradeHelper.accessor((t) => t.markouts[i] ?? null, {
          id: `m${h}`,
          header: `+${h}s`,
          size: 72,
          sortingFn: nullsLast(`m${h}`),
          meta: { label: `Mark-out +${h}s`, align: "right", title: `bps in our favor ${h}s after the fill`, filter: { kind: "range" } } satisfies ColMeta,
          cell: (c) => {
            const v = c.getValue();
            return v === null ? (
              <span className="text-faint" title={`due ${h}s after the fill`}>
                …
              </span>
            ) : (
              bps(v)
            );
          },
        }),
      ),
      tradeHelper.accessor("kept", {
        id: "kept",
        header: "Kept",
        size: 72,
        sortingFn: nullsLast("kept"),
        meta: {
          label: "Kept",
          align: "right",
          title: "The last mark-out over the edge at fill",
          filter: { kind: "range", scale: 100, unit: "%" },
        } satisfies ColMeta,
        cell: (c) => pct(c.getValue()),
      }),
    ],
    [hz],
  );
  const facets = useMemo(() => {
    const count = (f: (r: TradeRow) => string) => {
      const m = new Map<string, number>();
      for (const r of rows) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
      return [...m].map(([value, count]) => ({ value, count }));
    };
    return { symbol: count((r) => r.symbol), side: count((r) => r.side), kind: count((r) => r.kind) };
  }, [rows]);
  return (
    <DataTable<TradeRow>
      id={id}
      data={rows}
      columns={columns as ColumnDef<TradeRow, unknown>[]}
      getRowId={(r) => r.id}
      defaultSorting={[{ id: "time", desc: true }]}
      filters={filters}
      onFiltersChange={setFilters}
      facets={facets}
      empty="No fills yet this run"
    />
  );
}
