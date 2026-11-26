import { Info } from "lucide-react";
import type { QuoterDeskStatus } from "../../../shared/api.ts";
import { price as fmtPrice, qty as fmtQty, quoteUnit } from "../format.ts";
import { openPnl, type OpenPnlRow, type OpenPnlTotal } from "../open-pnl.ts";
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
  return (
    <Panel title="Open PnL" className="h-full" actions={<Totals totals={r.totals} />}>
      <div className="h-full overflow-y-auto">
        <p className="flex items-start gap-1.5 border-b border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
          <Info size={12} className="mt-0.5 shrink-0" />
          {RULE}
        </p>
        {r.rows.length === 0 ? (
          <Empty>No books yet.</Empty>
        ) : phone ? (
          <div className="flex flex-col gap-2 p-2">
            {r.rows.map((row) => (
              <BookCard key={row.symbol} r={row} onOpen={onOpen} />
            ))}
          </div>
        ) : (
          <BookTable rows={r.rows} onOpen={onOpen} />
        )}
        <p className="px-3 py-2 text-[11px] leading-relaxed text-faint">
          Reset on a book&apos;s Position card makes what it holds now its starting position: position, average cost and PnL go to zero.
        </p>
      </div>
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

function BookTable({ rows, onOpen }: { rows: OpenPnlRow[]; onOpen: (symbol: string) => void }) {
  const th = "px-3 py-1.5 font-medium";
  const r = cx(th, "text-right");
  const td = "px-3 py-1.5 text-right";
  return (
    <div className="overflow-x-auto">
      <table className="num w-full text-xs whitespace-nowrap">
        <thead className="text-[11px] text-muted">
          <tr className="border-b border-line">
            <th className={cx(th, "text-left")}>Book</th>
            <th className={r} title={STARTING_TITLE}>
              Starting
            </th>
            <th className={r} title="The book's own fills since it started or was last reset: what open PnL counts. Hover a figure for since when.">
              Position
            </th>
            <th className={r}>Avg cost</th>
            <th className={r} title="The book's reference mid, what the position is marked to">
              Mark
            </th>
            <th className={r} title="How far the mark is from the average cost, in bps of the cost">
              Move
            </th>
            <th className={r} title="(mark − avg cost) × position">
              Open
            </th>
            <th className={r} title={EXIT_TITLE}>
              If closed now
            </th>
            <th className={r} title="PnL on what the book has bought and sold back since it started counting, before fees">
              Realized
            </th>
            <th className={r} title="What the exchange charged for the fills counted in the position">
              Fees
            </th>
            <th className={r} title="Realized plus open, less fees">
              Net
            </th>
            <th className={r} title="How much of the max position change the position uses, and the room left the way it's going">
              Room
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.symbol} className={cx("border-b border-line/60", row.status === "flat" && "text-muted")}>
              <td className="px-3 py-1.5 text-left">
                <span className="flex items-center gap-2">
                  <SymbolLink onOpen={() => onOpen(row.symbol)} title="Open this book">
                    {row.symbol}
                  </SymbolLink>
                  <StatusTag r={row} />
                </span>
              </td>
              <td className={td}>
                <Starting r={row} />
              </td>
              <td className={td} title={`Since ${since(row.since)}`}>
                <Signed v={row.position} />
              </td>
              <td className={td}>{row.avgCost === null ? <Dash /> : fmtPrice(row.avgCost)}</td>
              <td className={td}>{row.mark === null ? <Dash /> : fmtPrice(row.mark)}</td>
              <td className={td}>
                <Bps v={row.moveBps} />
              </td>
              <td className={cx(td, "font-medium")}>
                <Money v={row.open} />
              </td>
              <td className={td}>
                <ExitCell r={row} />
              </td>
              <td className={td}>
                <Money v={row.realized} />
              </td>
              <td className={td}>
                <Fees v={row.fees} />
              </td>
              <td className={cx(td, "font-medium")}>
                <Money v={row.net} />
              </td>
              <td className={td}>
                <Room r={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
