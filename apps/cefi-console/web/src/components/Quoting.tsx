import { createColumnHelper, type ColumnDef, type ColumnFiltersState } from "@tanstack/react-table";
import { Info } from "lucide-react";
import { useMemo, useState } from "react";
import type { QuoterDeskStatus, QuoterOrder } from "../../../shared/api.ts";
import { price as fmtPrice } from "../format.ts";
import { quotingRows, type QuotingRow, type TakeGauge } from "../quoting.ts";
import { DataTable, type ColMeta } from "../table/DataTable.tsx";
import { Help } from "./help.tsx";
import { usePhone } from "./Phone.tsx";
import { layoutTrack, TrackBar, type TrackOrder } from "./QuoteTrack.tsx";
import { cx, Empty, Panel, SymbolLink } from "./ui.tsx";

// What every book is quoting right now against the exchange: the EBBO beside the book's own best
// bid and ask, the spreads, how many quotes rest each side, the track from the market tiles, the
// skew on the mid, and how close each side is to a take.

const RULE =
  "BBO is the exchange's best bid and ask; mine is this book's best resting quote each side, with how far it sits behind the BBO. " +
  "On the track, your quotes are the yellow marks, placed by bps behind the touch, and the caret is the skewed mid the ladder centres on. " +
  "Skew shows which way the mid is shaded and how much of its cap is used. Take shows each side's edge against what a take needs: sell hits the bid, buy lifts the ask.";

const SKEW_TITLE =
  "How far the mid is shaded to get the position back toward flat, against the cap (the Inventory skew parameter): to the left while it's shaded down (long, leaning to sell), " +
  "to the right while shaded up (short, leaning to buy)";

const TAKE_TITLE =
  "How close each side is to a take: its edge over the skewed mid, after the fee, against what a take needs. Sell hits the best bid on the left; buy lifts the best ask on the right. " +
  "A full half in colour would take now; amber is close; off is a taker that's switched off";

export function QuotingView({ d, onOpen }: { d: QuoterDeskStatus; onOpen: (symbol: string) => void }) {
  const phone = usePhone();
  const rows = quotingRows(d);
  const quoting = rows.filter((r) => r.state === "quoting").length;
  const rule = (
    <Help>
      <p className="flex shrink-0 items-start gap-1.5 border-b border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
        <Info size={12} className="mt-0.5 shrink-0" />
        {RULE}
      </p>
    </Help>
  );
  const old = rows.length > 0 && rows.every((r) => !r.known);
  return (
    <Panel
      title="Quoting"
      className="h-full"
      actions={
        <span className="num text-xs text-faint">
          {quoting} of {rows.length} quoting
        </span>
      }
    >
      {old ? (
        <Empty>This quoter is too old to send what each book is quoting. Update it to see the BBO, quotes, skew and takes here.</Empty>
      ) : phone ? (
        <div className="h-full overflow-y-auto">
          {rule}
          {rows.length === 0 ? (
            <Empty>No books yet.</Empty>
          ) : (
            <div className="flex flex-col gap-2 p-2">
              {rows.map((r) => (
                <BookCard key={r.symbol} r={r} onOpen={onOpen} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          {rule}
          <div className="min-h-0 flex-1">
            <BookTable rows={rows} onOpen={onOpen} />
          </div>
        </div>
      )}
    </Panel>
  );
}

const col = createColumnHelper<QuotingRow>();

// A number column: right-aligned, blanks sorted last. Filtered by range only where that helps,
// since a filter widens the header.
const num = (label: string, title: string, filter = false) => ({
  sortUndefined: "last" as const,
  meta: { label, align: "right", title, ...(filter && { filter: { kind: "range" as const } }) } satisfies ColMeta,
});

function BookTable({ rows, onOpen }: { rows: QuotingRow[]; onOpen: (symbol: string) => void }) {
  const [filters, setFilters] = useState<ColumnFiltersState>([]);
  const columns = useMemo(
    () =>
      [
        col.accessor("symbol", {
          id: "book",
          header: "Book",
          size: 120,
          meta: { label: "Book", filter: { kind: "multi" } } satisfies ColMeta,
          cell: (c) => (
            <span className="flex items-center gap-2">
              <SymbolLink onOpen={() => onOpen(c.row.original.symbol)} title="Open this book">
                {c.getValue()}
              </SymbolLink>
              <StateTag r={c.row.original} />
            </span>
          ),
        }),
        col.accessor((r) => r.bboBid ?? undefined, {
          id: "bboBid",
          header: "BBO bid",
          size: 84,
          ...num("BBO bid", "The exchange's best bid"),
          cell: (c) => <Px v={c.getValue()} className="text-buy" />,
        }),
        col.accessor((r) => r.bboAsk ?? undefined, {
          id: "bboAsk",
          header: "BBO ask",
          size: 84,
          ...num("BBO ask", "The exchange's best ask"),
          cell: (c) => <Px v={c.getValue()} className="text-sell" />,
        }),
        col.accessor((r) => r.myBid ?? undefined, {
          id: "myBid",
          header: "My bid",
          size: 96,
          ...num("My bid", "This book's best resting bid, and how far behind the BBO bid it is"),
          cell: (c) => <Mine v={c.getValue()} behind={c.row.original.bidBehindBps} className="text-buy" />,
        }),
        col.accessor((r) => r.myAsk ?? undefined, {
          id: "myAsk",
          header: "My ask",
          size: 96,
          ...num("My ask", "This book's best resting ask, and how far behind the BBO ask it is"),
          cell: (c) => <Mine v={c.getValue()} behind={c.row.original.askBehindBps} className="text-sell" />,
        }),
        col.accessor((r) => r.bboSpreadBps ?? undefined, {
          id: "bboSpread",
          header: "BBO spread",
          size: 96,
          ...num("BBO spread", "The exchange's best ask less its best bid, in bps of the mid; hover for the price"),
          cell: (c) => <Spread bps={c.getValue()} px={c.row.original.bboSpread} />,
        }),
        col.accessor((r) => r.quoteSpreadBps ?? undefined, {
          id: "quoteSpread",
          header: "My spread",
          size: 92,
          ...num("Quote spread", "This book's best ask less its best bid, in bps of the mid; hover for the price"),
          cell: (c) => <Spread bps={c.getValue()} px={c.row.original.quoteSpread} />,
        }),
        col.accessor("bids", {
          id: "bids",
          header: "Bids",
          size: 52,
          ...num("Bid quotes", "How many bids the book rests"),
          cell: (c) => <Count n={c.getValue()} />,
        }),
        col.accessor("asks", {
          id: "asks",
          header: "Asks",
          size: 52,
          ...num("Ask quotes", "How many asks the book rests"),
          cell: (c) => <Count n={c.getValue()} />,
        }),
        col.display({
          id: "track",
          header: "Quotes",
          size: 140,
          meta: {
            label: "Quotes",
            title: "The BBO's touch marks with your quotes either side, placed by bps behind the touch, and a caret at the skewed mid",
          } satisfies ColMeta,
          cell: (c) => <Track r={c.row.original} />,
        }),
        col.accessor((r) => r.skewLean ?? undefined, {
          id: "skew",
          header: "Skew",
          size: 120,
          sortUndefined: "last",
          meta: { label: "Skew", title: SKEW_TITLE, filter: { kind: "range", scale: 100, unit: "%" } } satisfies ColMeta,
          cell: (c) => <Skew r={c.row.original} />,
        }),
        col.accessor((r) => (r.take ? Math.max(r.take.sell.enabled ? r.take.sell.closeness : 0, r.take.buy.enabled ? r.take.buy.closeness : 0) : undefined), {
          id: "take",
          header: "Take",
          size: 140,
          sortUndefined: "last",
          meta: { label: "Take", title: TAKE_TITLE + ". Sorts by the closer side", filter: { kind: "range", scale: 100, unit: "%" } } satisfies ColMeta,
          cell: (c) => <Take r={c.row.original} />,
        }),
      ] as ColumnDef<QuotingRow, unknown>[],
    [onOpen],
  );
  const facets = useMemo(() => ({ book: rows.map((r) => ({ value: r.symbol, count: 1 })) }), [rows]);
  return (
    <DataTable<QuotingRow>
      id="quoter-quoting"
      data={rows}
      columns={columns}
      getRowId={(r) => r.symbol}
      defaultSorting={[]}
      filters={filters}
      onFiltersChange={setFilters}
      facets={facets}
      rowClassName={(r) => r.state !== "quoting" && "text-muted"}
      empty={rows.length ? "No books match these filters." : "No books yet."}
    />
  );
}

function BookCard({ r, onOpen }: { r: QuotingRow; onOpen: (symbol: string) => void }) {
  return (
    <div className={cx("num flex flex-col gap-1 rounded-md border border-line px-3 py-2 text-xs", r.state !== "quoting" && "text-muted")}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-2">
          <SymbolLink onOpen={() => onOpen(r.symbol)} title="Open this book">
            {r.symbol}
          </SymbolLink>
          <StateTag r={r} />
        </span>
        <span className="text-faint">
          {r.bids} bids · {r.asks} asks
        </span>
      </div>
      <div className="grid grid-cols-[auto_1fr_1fr_auto] items-baseline gap-x-3">
        <span className="text-faint">BBO</span>
        <Px v={r.bboBid ?? undefined} className="text-right text-buy" />
        <Px v={r.bboAsk ?? undefined} className="text-sell" />
        <Spread bps={r.bboSpreadBps ?? undefined} px={r.bboSpread} />
        <span className="text-faint">mine</span>
        <Mine v={r.myBid ?? undefined} behind={r.bidBehindBps} className="text-right text-buy" />
        <Mine v={r.myAsk ?? undefined} behind={r.askBehindBps} className="text-sell" />
        <Spread bps={r.quoteSpreadBps ?? undefined} px={r.quoteSpread} />
      </div>
      <Track r={r} />
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1">
        <span className="text-faint" title={SKEW_TITLE}>
          skew
        </span>
        <Skew r={r} />
        <span className="text-faint" title={TAKE_TITLE}>
          take
        </span>
        <Take r={r} />
      </div>
    </div>
  );
}

function StateTag({ r }: { r: QuotingRow }) {
  if (r.state === "quoting") return null;
  return (
    <span
      className={cx("rounded px-1.5 py-0.5 font-sans text-[10px] font-semibold", r.state === "waiting" ? "bg-accent-soft text-accent" : "bg-raised text-muted")}
    >
      {r.state}
    </span>
  );
}

const Dash = () => <span className="text-faint">—</span>;

function Px({ v, className }: { v: number | undefined; className?: string }) {
  return v === undefined ? <Dash /> : <span className={className}>{fmtPrice(v)}</span>;
}

// The book's best quote on a side, and how far behind the BBO it sits; at the touch it says so.
function Mine({ v, behind, className }: { v: number | undefined; behind: number | null; className?: string }) {
  if (v === undefined) return <Dash />;
  const touch = behind !== null && behind < 0.05;
  return (
    <span
      className={className}
      title={behind === null ? undefined : touch ? "At the touch: the best price on its side" : `${behind.toFixed(1)} bps behind the BBO`}
    >
      {fmtPrice(v)}
      {behind !== null && <span className="ml-1 text-[10px] text-faint">{touch ? "touch" : `−${behind.toFixed(1)}`}</span>}
    </span>
  );
}

function Spread({ bps, px }: { bps: number | undefined; px: number | null }) {
  if (bps === undefined) return <Dash />;
  return <span title={px === null ? undefined : `${fmtPrice(px)} wide`}>{bps.toFixed(1)} bps</span>;
}

function Count({ n }: { n: number }) {
  return <span className={n === 0 ? "text-faint" : ""}>{n}</span>;
}

// The BBO with your quotes on it, as on the market tiles, and the skewed mid as a caret.
function Track({ r }: { r: QuotingRow }) {
  const t = r.bboBid !== null && r.bboAsk !== null ? layoutTrack(r.bboBid, r.bboAsk, r.quotes.map(toTrack), r.mid ?? undefined) : undefined;
  if (!t) return <span className="text-[11px] text-faint">{r.quotes.length ? "no BBO yet" : "—"}</span>;
  return <TrackBar t={t} className="w-full" midTitle={r.mid === null ? undefined : `Skewed mid ${fmtPrice(r.mid)}`} />;
}

const toTrack = (o: QuoterOrder): TrackOrder => ({ orderId: o.externalId, side: o.side, price: o.price, leavesQty: o.leaves, status: o.status });

// Which way the mid is shaded, against the cap: left while shaded down, right while up.
function Skew({ r }: { r: QuotingRow }) {
  if (r.skewLean === null)
    return (
      <span className="text-[11px] text-faint" title="No inventory skew set">
        off
      </span>
    );
  // Positive skew lowers the mid, so it draws to the left.
  const l = -r.skewLean;
  const none = Math.abs(r.skewBps) < 0.05;
  const text = none ? "none" : `${r.skewBps > 0 ? "↓" : "↑"} ${Math.abs(r.skewBps).toFixed(1)} bps`;
  return (
    <span
      className="flex w-full items-center gap-2"
      title={`Mid shaded ${r.skewBps === 0 ? "nowhere" : `${r.skewBps > 0 ? "down" : "up"} ${Math.abs(r.skewBps).toFixed(2)} bps`}: ${Math.round(Math.abs(r.skewLean) * 100)}% of the ${r.skewMaxBps} bps cap`}
    >
      <Halves left={l < 0 ? -l : 0} right={l > 0 ? l : 0} leftClass="bg-accent" rightClass="bg-accent" />
      <span className={cx("num w-16 shrink-0 text-right text-[11px] whitespace-nowrap", none ? "text-faint" : "text-muted")}>{text}</span>
    </span>
  );
}

// How close each side is to a take: sell on the left, buy on the right.
function Take({ r }: { r: QuotingRow }) {
  if (!r.take) return <Dash />;
  const { sell, buy } = r.take;
  return (
    <span className="flex w-full items-center gap-1.5">
      <TakeLabel g={sell} side="sell" />
      <span className="flex min-w-16 flex-1" title={`${sideTitle("Sell", sell)}\n${sideTitle("Buy", buy)}`}>
        <Halves
          left={sell.enabled ? Math.min(1, sell.closeness) : 0}
          right={buy.enabled ? Math.min(1, buy.closeness) : 0}
          leftClass={fill(sell, "bg-sell")}
          rightClass={fill(buy, "bg-buy")}
          leftOff={!sell.enabled}
          rightOff={!buy.enabled}
        />
      </span>
      <TakeLabel g={buy} side="buy" />
    </span>
  );
}

function fill(g: TakeGauge, would: string) {
  if (g.would) return would;
  return g.closeness >= 0.75 ? "bg-accent" : "bg-faint";
}

function TakeLabel({ g, side }: { g: TakeGauge; side: "sell" | "buy" }) {
  const text = !g.enabled ? "off" : g.would ? "take" : `${Math.round(Math.min(1, g.closeness) * 100)}%`;
  return (
    <span
      className={cx(
        "num w-8 shrink-0 text-[11px]",
        side === "sell" ? "text-right" : "text-left",
        !g.enabled ? "text-faint" : g.would ? (side === "sell" ? "text-sell" : "text-buy") : g.closeness >= 0.75 ? "text-accent" : "text-muted",
      )}
    >
      {text}
    </span>
  );
}

function sideTitle(name: string, g: TakeGauge) {
  if (!g.enabled) return `${name}: the ${g.kind} is off`;
  const edge = g.edgeBps === null ? "nothing to take" : `edge ${g.edgeBps.toFixed(1)} of the ${g.thresholdBps} bps needed`;
  const short = g.shortBps !== null && g.shortBps > 0 ? `, ${g.shortBps.toFixed(1)} bps short` : "";
  return `${name} (${g.kind}): ${edge}${short}; ${g.would ? "would take now" : `not taking: ${g.blocker}`}`;
}

// A bar with zero in the middle, each half filled out from it, 0 to 1.
function Halves({
  left,
  right,
  leftClass,
  rightClass,
  leftOff,
  rightOff,
}: {
  left: number;
  right: number;
  leftClass: string;
  rightClass: string;
  leftOff?: boolean;
  rightOff?: boolean;
}) {
  const off = "bg-[repeating-linear-gradient(135deg,transparent_0_3px,var(--color-line)_3px_5px)]";
  return (
    <span className="relative h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-raised">
      {leftOff && <span className={cx("absolute inset-y-0 left-0 w-1/2", off)} />}
      {rightOff && <span className={cx("absolute inset-y-0 right-0 w-1/2", off)} />}
      <span className={cx("absolute inset-y-0 right-1/2", leftClass)} style={{ width: `${left * 50}%` }} />
      <span className={cx("absolute inset-y-0 left-1/2", rightClass)} style={{ width: `${right * 50}%` }} />
      <span className="absolute -inset-y-px left-1/2 w-px bg-faint" />
    </span>
  );
}
