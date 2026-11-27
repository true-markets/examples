import { createColumnHelper, type ColumnDef, type ColumnFiltersState } from "@tanstack/react-table";
import { Info } from "lucide-react";
import { useMemo, useState } from "react";
import type { QuoterDeskStatus } from "../../../shared/api.ts";
import { price as fmtPrice, qty as fmtQty, quoteUnit } from "../format.ts";
import { openPnl, type OpenPnlRow, type OpenPnlTotal } from "../open-pnl.ts";
import { DataTable, type ColMeta } from "../table/DataTable.tsx";
import { Help } from "./help.tsx";
import { usePhone } from "./Phone.tsx";
import { InventoryBar } from "./InventoryBar.tsx";
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
  "Exit PnL: what closing the position now would come to against the exchange's book, selling a long into the bids or buying a short back from the asks, " +
  "level by level and around this book's own orders. Against the average cost, before fees. Hover a figure for its unwind cost: how much worse that is than the mid mark.";

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
          header: "Exit PnL",
          size: 110,
          ...num("Exit PnL", EXIT_TITLE, "$"),
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
        col.accessor((r) => r.inventory?.lean, {
          id: "inventory",
          header: "Inventory",
          size: 180,
          sortUndefined: "last",
          meta: {
            label: "Inventory",
            title:
              "Inventory against the max position change: green to the right while long, red to the left while short, out to the limit each way. " +
              "Sorts from the most short to the most long; filter by −100% (the limit short) to +100% (long)",
            filter: { kind: "range", scale: 100, unit: "%" },
          } satisfies ColMeta,
          cell: (c) => <Inventory r={c.row.original} />,
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
              exit <ExitCell r={r} />
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
      <Inventory r={r} left />
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
    x.unwindUsd !== null &&
      x.unwindBps !== null &&
      `unwind cost ${x.unwindUsd < 0 ? "−" : "+"}${fmtMoney(Math.abs(x.unwindUsd))} (${Math.abs(x.unwindBps).toFixed(1)} bps ${x.unwindBps < 0 ? "worse" : "better"} than the mid)`,
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

// The inventory against the max position change, as a two-sided bar, with how much further it may go
// the way it's going.
function Inventory({ r, left }: { r: OpenPnlRow; left?: boolean }) {
  const x = r.inventory;
  if (!x)
    return (
      <span className="text-faint" title="No max position change set">
        —
      </span>
    );
  return (
    <span className="flex items-center gap-2">
      <InventoryBar lean={x.lean} max={x.max} buyRoom={x.buyRoom} sellRoom={x.sellRoom} base={r.base} />
      {left && x.lean !== 0 && <span className="shrink-0 text-[11px] text-faint">{x.leftUsd === null ? fmtQty(x.left, 6) : fmtMoney(x.leftUsd)} left</span>}
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

// Cents from a dollar up; under a dollar 3 places, and under a cent 4, so small figures don't read as 0.
function fmtMoney(v: number) {
  const a = Math.abs(v);
  const places = a === 0 || a >= 1 ? 2 : a >= 0.01 ? 3 : 4;
  return (v < 0 ? "−" : "") + "$" + a.toLocaleString(undefined, { minimumFractionDigits: places, maximumFractionDigits: places });
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
