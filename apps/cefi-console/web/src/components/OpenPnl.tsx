import { createColumnHelper, type ColumnDef, type ColumnFiltersState } from "@tanstack/react-table";
import { Info } from "lucide-react";
import { useMemo, useState } from "react";
import type { QuoterDeskStatus } from "../../../shared/api.ts";
import { price as fmtPrice, qty as fmtQty, quoteUnit } from "../format.ts";
import { openPnl, type OpenPnlRow, type OpenPnlTotal } from "../open-pnl.ts";
import { DataTable, type ColMeta } from "../table/DataTable.tsx";
import { Help } from "./help.tsx";
import { usePhone } from "./Phone.tsx";
import { cx, Empty, Panel, SymbolLink } from "./ui.tsx";

// The open PnL, book by book: what each book started with, its own position since then, and that
// position marked to the reference mid.

const RULE =
  "Open = (reference mid − avg cost) × position, per book. Position is the book's own fills since it started or was last reset; " +
  "the starting position is what else the account holds in the asset, and adds nothing to open. Net is realized plus open, less fees.";

const STARTING_TITLE =
  "What the account holds in this asset beyond the books' own positions: there before they started counting, or traded by hand. It adds nothing to open.";

export function OpenPnlView({ d, onOpen }: { d: QuoterDeskStatus; onOpen: (symbol: string) => void }) {
  const phone = usePhone();
  const r = openPnl(d);
  // Explanations, hidden with the Help switch; the columns' tooltips say the same.
  const rule = (
    <Help>
      <p className="flex shrink-0 items-start gap-1.5 border-b border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
        <Info size={12} className="mt-0.5 shrink-0" />
        {RULE}
      </p>
    </Help>
  );
  const note = (
    <Help>
      <p className="shrink-0 px-3 py-2 text-[11px] leading-relaxed text-faint">
        Reset on a book&apos;s Position card makes what it holds now its starting position: position, average cost and PnL go to zero.
      </p>
    </Help>
  );
  return (
    <Panel title="Open PnL" className="h-full" actions={<Totals totals={r.totals} />}>
      {phone ? (
        <div className="h-full overflow-y-auto">
          {rule}
          {r.rows.length === 0 ? (
            <Empty>No books yet.</Empty>
          ) : (
            <div className="flex flex-col gap-2 p-2">
              {r.rows.map((row) => (
                <BookCard key={row.symbol} r={row} onOpen={onOpen} />
              ))}
            </div>
          )}
          {note}
        </div>
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          {rule}
          <div className="min-h-0 flex-1">
            <BookTable rows={r.rows} onOpen={onOpen} />
          </div>
          {note}
        </div>
      )}
    </Panel>
  );
}

function Totals({ totals }: { totals: OpenPnlTotal[] }) {
  return (
    <span className="num flex flex-wrap items-baseline gap-x-3 text-xs">
      {totals.map((t) => (
        <span key={t.quote} title="Realized plus open, less fees">
          <span className="text-faint">open</span> <Money v={t.open} /> <span className="text-faint">· net</span> <Money v={t.net} />{" "}
          <span className="text-faint">{quoteUnit(t.quote)}</span>
        </span>
      ))}
    </span>
  );
}

const EXIT_TITLE =
  "What closing the position now would come to against the exchange's book: selling a long into the bids, buying a short back from the asks, " +
  "level by level and around this book's own orders. The PnL is against the average cost, before fees.";

const col = createColumnHelper<OpenPnlRow>();

// A number column: right-aligned, sorted with blanks last, filtered by range.
const num = (label: string, title: string, unit?: "$") => ({
  sortUndefined: "last" as const,
  meta: { label, align: "right", title, filter: { kind: "range", unit } } satisfies ColMeta,
});

// The same table as the rest of the console: sort by any column, filter, and drag, resize or hide
// columns from the menu; the layout is remembered.
function BookTable({ rows, onOpen }: { rows: OpenPnlRow[]; onOpen: (symbol: string) => void }) {
  const [filters, setFilters] = useState<ColumnFiltersState>([]);
  const columns = useMemo(
    () =>
      [
        col.accessor("symbol", {
          id: "book",
          header: "Book",
          size: 150,
          meta: { label: "Book", filter: { kind: "multi" } } satisfies ColMeta,
          cell: (c) => (
            <span className="flex items-center gap-2">
              <SymbolLink onOpen={() => onOpen(c.row.original.symbol)} title="Open this book">
                {c.getValue()}
              </SymbolLink>
              <StatusTag r={c.row.original} />
            </span>
          ),
        }),
        col.accessor((r) => r.starting ?? undefined, {
          id: "starting",
          header: "Starting",
          size: 96,
          ...num("Starting position", STARTING_TITLE),
          cell: (c) => <Starting r={c.row.original} />,
        }),
        col.accessor("position", {
          id: "position",
          header: "Position",
          size: 96,
          ...num("Position", "The book's own fills since it started or was last reset: what open PnL counts. Hover a figure for since when."),
          cell: (c) => (
            <span title={`Since ${since(c.row.original.since)}`}>
              <Signed v={c.getValue()} />
            </span>
          ),
        }),
        col.accessor((r) => r.avgCost ?? undefined, {
          id: "avgCost",
          header: "Avg cost",
          size: 96,
          ...num("Avg cost", "The average price of the position"),
          cell: (c) => (c.getValue() === undefined ? <Dash /> : fmtPrice(c.getValue()!)),
        }),
        col.accessor((r) => r.mark ?? undefined, {
          id: "mark",
          header: "Mark",
          size: 96,
          ...num("Mark", "The book's reference mid, what the position is marked to"),
          cell: (c) => (c.getValue() === undefined ? <Dash /> : fmtPrice(c.getValue()!)),
        }),
        col.accessor((r) => r.moveBps ?? undefined, {
          id: "move",
          header: "Move",
          size: 88,
          ...num("Move", "How far the mark is from the average cost, in bps of the cost"),
          cell: (c) => <Bps v={c.getValue() ?? null} />,
        }),
        col.accessor("open", {
          id: "open",
          header: "Open",
          size: 88,
          ...num("Open", "(mark − avg cost) × position", "$"),
          cell: (c) => (
            <span className="font-medium">
              <Money v={c.getValue()} />
            </span>
          ),
        }),
        col.accessor((r) => r.exit?.pnl, {
          id: "exit",
          header: "If closed now",
          size: 110,
          ...num("If closed now", EXIT_TITLE, "$"),
          cell: (c) => <ExitCell r={c.row.original} />,
        }),
        col.accessor("realized", {
          id: "realized",
          header: "Realized",
          size: 88,
          ...num("Realized", "PnL on what the book has bought and sold back since it started counting, before fees", "$"),
          cell: (c) => <Money v={c.getValue()} />,
        }),
        col.accessor((r) => r.fees ?? undefined, {
          id: "fees",
          header: "Fees",
          size: 80,
          ...num("Fees", "What the exchange charged for the fills counted in the position", "$"),
          cell: (c) => <Fees v={c.getValue() ?? null} />,
        }),
        col.accessor("net", {
          id: "net",
          header: "Net",
          size: 88,
          ...num("Net", "Realized plus open, less fees", "$"),
          cell: (c) => (
            <span className="font-medium">
              <Money v={c.getValue()} />
            </span>
          ),
        }),
        col.accessor((r) => r.room?.used, {
          id: "room",
          header: "Room",
          size: 130,
          sortUndefined: "last",
          meta: {
            label: "Room",
            align: "right",
            title: "How much of the max position change the position uses, and the room left the way it's going",
            filter: { kind: "range", scale: 100, unit: "%" },
          } satisfies ColMeta,
          cell: (c) => <Room r={c.row.original} />,
        }),
      ] as ColumnDef<OpenPnlRow, unknown>[],
    [onOpen],
  );
  const facets = useMemo(() => ({ book: rows.map((r) => ({ value: r.symbol, count: 1 })) }), [rows]);
  return (
    <DataTable<OpenPnlRow>
      id="quoter-open-pnl"
      data={rows}
      columns={columns}
      getRowId={(r) => r.symbol}
      defaultSorting={[]}
      filters={filters}
      onFiltersChange={setFilters}
      facets={facets}
      rowClassName={(r) => r.status === "flat" && "text-muted"}
      empty={rows.length ? "No books match these filters." : "No books yet."}
    />
  );
}

function BookCard({ r, onOpen }: { r: OpenPnlRow; onOpen: (symbol: string) => void }) {
  return (
    <div className={cx("num flex flex-col gap-1 rounded-md border border-line px-3 py-2 text-xs", r.status === "flat" && "text-muted")}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-2">
          <SymbolLink onOpen={() => onOpen(r.symbol)} title="Open this book">
            {r.symbol}
          </SymbolLink>
          <StatusTag r={r} />
        </span>
        <span className="text-sm font-medium" title="Realized plus open, less fees">
          <span className="text-[10px] font-normal text-faint">net </span>
          <Money v={r.net} />
        </span>
      </div>
      <div className="flex justify-between text-muted">
        <span title={STARTING_TITLE}>
          start <Starting r={r} />
        </span>
        <span>
          pos <Signed v={r.position} />
        </span>
      </div>
      {r.status !== "flat" && (
        <>
          <div className="flex justify-between text-faint">
            <span>avg {r.avgCost === null ? "—" : fmtPrice(r.avgCost)}</span>
            <span>
              mark {r.mark === null ? "—" : fmtPrice(r.mark)} · <Bps v={r.moveBps} />
            </span>
          </div>
          <div className="flex justify-between text-muted">
            <span>
              open <Money v={r.open} />
            </span>
            <span title={EXIT_TITLE}>
              if closed <ExitCell r={r} />
            </span>
          </div>
        </>
      )}
      <div className="flex justify-between text-muted">
        <span>
          realized <Money v={r.realized} />
        </span>
        <span>
          fees <Fees v={r.fees} />
        </span>
      </div>
      <div className="text-faint">
        room <Room r={r} />
      </div>
      <div className="text-faint">since {since(r.since)}</div>
    </div>
  );
}

// The exit's PnL, with its average price and how far down the book it would go.
function ExitCell({ r }: { r: OpenPnlRow }) {
  const x = r.exit;
  if (!x) return <Dash />;
  const parts = [
    `average ${fmtPrice(x.price)} over ${x.levels} level${x.levels === 1 ? "" : "s"}`,
    `${fmtMoney(x.value)} ${r.position > 0 ? "in" : "out"}`,
    x.partialQty !== null && `only ${fmtQty(x.partialQty, 6)} of the ${fmtQty(Math.abs(r.position), 6)}: the book is too thin for the rest`,
    x.topOnly && "priced off the best bid or ask alone: the full book isn't in yet",
  ].filter(Boolean);
  return (
    <span title={parts.join("; ")}>
      <Money v={x.pnl} />
      {(x.partialQty !== null || x.topOnly) && <span className="text-accent">*</span>}
    </span>
  );
}

function Fees({ v }: { v: number | null }) {
  if (v === null) return <Dash />;
  return <span className={v > 0 ? "text-sell" : ""}>{v > 0 ? "−" + fmtMoney(v) : fmtMoney(v)}</span>;
}

// Share of the max position change used, then what's left the way the position is going.
function Room({ r }: { r: OpenPnlRow }) {
  const x = r.room;
  if (!x)
    return (
      <span className="text-faint" title="No max position change set">
        —
      </span>
    );
  const pct = Math.round(x.used * 100);
  return (
    <span title={`${fmtQty(x.left, 6)} ${r.base} more it may ${r.position >= 0 ? "buy" : "sell"} under the max position change`}>
      <span className={pct >= 90 ? "text-sell" : pct >= 70 ? "text-accent" : ""}>{pct}%</span>
      <span className="text-faint"> · {x.leftUsd === null ? fmtQty(x.left, 6) : fmtMoney(x.leftUsd)} left</span>
    </span>
  );
}

// Flat and unpriced books add nothing to open; the tag says why.
function StatusTag({ r }: { r: OpenPnlRow }) {
  if (r.status === "counted") return null;
  const flat = r.status === "flat";
  return (
    <span
      className={cx("rounded px-1.5 py-0.5 font-sans text-[10px] font-semibold", flat ? "bg-raised text-muted" : "bg-accent-soft text-accent")}
      title={
        flat
          ? `Nothing to mark: its buys and sells netted out, and the ${fmtMoney(r.realized)} they made is in realized`
          : "No reference price to mark the position to yet, so it counts as 0"
      }
    >
      {flat ? "flat" : "no reference"}
    </span>
  );
}

function Starting({ r }: { r: OpenPnlRow }) {
  if (r.starting === null) return <Dash />;
  return (
    <span title={r.sharedStart ? `Shared by every book that trades ${r.base}` : undefined}>
      {fmtQty(r.starting, 6)}
      {r.sharedStart && <span className="text-faint">*</span>}
    </span>
  );
}

const Dash = () => <span className="text-faint">—</span>;

function fmtMoney(v: number) {
  const a = Math.abs(v);
  return (
    (v < 0 ? "−" : "") + "$" + a.toLocaleString(undefined, { minimumFractionDigits: a < 1 && a > 0 ? 3 : 2, maximumFractionDigits: a < 1 && a > 0 ? 3 : 2 })
  );
}

// Cents for bigger figures; under a dollar, enough places that small PnL doesn't read as zero.
function Money({ v }: { v: number }) {
  return <span className={v > 0 ? "text-buy" : v < 0 ? "text-sell" : ""}>{(v > 0 ? "+" : "") + fmtMoney(v)}</span>;
}

function Signed({ v }: { v: number }) {
  return <span className={v > 0 ? "text-buy" : v < 0 ? "text-sell" : ""}>{(v > 0 ? "+" : v < 0 ? "−" : "") + fmtQty(Math.abs(v), 6)}</span>;
}

function Bps({ v }: { v: number | null }) {
  if (v === null) return <Dash />;
  return <span className={v > 0 ? "text-buy" : v < 0 ? "text-sell" : ""}>{(v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1)} bps</span>;
}

function since(iso: string | null) {
  if (!iso) return "—";
  const t = new Date(iso);
  if (t.getFullYear() < 2000) return "—";
  return t.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
