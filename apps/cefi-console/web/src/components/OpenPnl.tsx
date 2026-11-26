import { Info } from "lucide-react";
import type { ReactNode } from "react";
import type { QuoterDeskStatus } from "../../../shared/api.ts";
import { price as fmtPrice, qty as fmtQty, quoteUnit } from "../format.ts";
import { openPnl, type CountedBook, type NotCounted } from "../open-pnl.ts";
import { usePhone } from "./Phone.tsx";
import { cx, Empty, Panel, SymbolLink } from "./ui.tsx";

// The open PnL, taken apart: the books whose position counts, marked to their reference mid, and
// everything else, with why it adds nothing.

const RULE = "Open = (reference mid − avg cost) × position, per book. A book's position counts only its own fills since it started or was last reset.";

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
        <Section title={`Counted · ${r.counted.length} book${r.counted.length === 1 ? "" : "s"}`}>
          {r.counted.length === 0 ? (
            <Empty>No book holds a position right now, so there's nothing open.</Empty>
          ) : phone ? (
            <div className="flex flex-col gap-2 p-2">
              {r.counted.map((c) => (
                <CountedCard key={c.symbol} c={c} onOpen={onOpen} />
              ))}
            </div>
          ) : (
            <CountedTable rows={r.counted} onOpen={onOpen} />
          )}
        </Section>
        <Section title="Not counted · adds nothing to open">
          {r.notCounted.length === 0 ? (
            <Empty>Everything the account holds is in a book's position.</Empty>
          ) : (
            <ul className="divide-y divide-line/60">
              {r.notCounted.map((n) => (
                <NotCountedRow key={n.kind === "outside" ? `outside-${n.asset}` : `${n.kind}-${n.symbol}`} n={n} onOpen={onOpen} />
              ))}
            </ul>
          )}
        </Section>
        <p className="px-3 py-2 text-[11px] leading-relaxed text-faint">
          Reset on a book&apos;s Position card makes what it holds now its starting point: position, average cost and PnL go to zero, and what it held moves
          outside the book.
        </p>
      </div>
    </Panel>
  );
}

function Totals({ totals }: { totals: { quote: string; open: number }[] }) {
  return (
    <span className="num text-xs">
      {totals.map((t, i) => (
        <span key={t.quote}>
          {i > 0 && <span className="text-faint"> · </span>}
          <Money v={t.open} /> <span className="text-faint">{quoteUnit(t.quote)}</span>
        </span>
      ))}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="border-b border-line bg-raised/40 px-3 py-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function CountedTable({ rows, onOpen }: { rows: CountedBook[]; onOpen: (symbol: string) => void }) {
  const th = "px-3 py-1.5 font-medium";
  const r = cx(th, "text-right");
  return (
    <div className="overflow-x-auto">
      <table className="num w-full text-xs">
        <thead className="text-[11px] text-muted">
          <tr className="border-b border-line">
            <th className={cx(th, "text-left")}>Book</th>
            <th className={r}>Position</th>
            <th className={r}>Avg cost</th>
            <th className={r} title="The book's reference mid, what the position is marked to">
              Mark
            </th>
            <th className={r} title="How far the mark is from the average cost, in bps of the cost">
              Move
            </th>
            <th className={r}>Open PnL</th>
            <th className={r} title="When the position started counting: the book's first start, or its last reset">
              Since
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.symbol} className="border-b border-line/60">
              <td className="px-3 py-1.5 text-left">
                <SymbolLink onOpen={() => onOpen(c.symbol)} title="Open this book">
                  {c.symbol}
                </SymbolLink>
              </td>
              <td className="px-3 py-1.5 text-right">
                <Signed v={c.position} />
              </td>
              <td className="px-3 py-1.5 text-right">{c.avgCost === null ? <span className="text-faint">—</span> : fmtPrice(c.avgCost)}</td>
              <td className="px-3 py-1.5 text-right">{fmtPrice(c.mark)}</td>
              <td className="px-3 py-1.5 text-right">
                <Bps v={c.moveBps} />
              </td>
              <td className="px-3 py-1.5 text-right font-medium">
                <Money v={c.open} />
              </td>
              <td className="px-3 py-1.5 text-right text-muted">{since(c.since)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CountedCard({ c, onOpen }: { c: CountedBook; onOpen: (symbol: string) => void }) {
  return (
    <div className="num flex flex-col gap-1 rounded-md border border-line px-3 py-2 text-xs">
      <div className="flex items-baseline justify-between">
        <SymbolLink onOpen={() => onOpen(c.symbol)} title="Open this book">
          {c.symbol}
        </SymbolLink>
        <span className="text-sm font-medium">
          <Money v={c.open} />
        </span>
      </div>
      <div className="flex justify-between text-muted">
        <span>
          pos <Signed v={c.position} />
        </span>
        <Bps v={c.moveBps} />
      </div>
      <div className="flex justify-between text-faint">
        <span>avg {c.avgCost === null ? "—" : fmtPrice(c.avgCost)}</span>
        <span>mark {fmtPrice(c.mark)}</span>
      </div>
      <div className="text-faint">since {since(c.since)}</div>
    </div>
  );
}

function NotCountedRow({ n, onOpen }: { n: NotCounted; onOpen: (symbol: string) => void }) {
  const [label, tag, tone, why] =
    n.kind === "flat"
      ? [
          <SymbolLink key="s" onOpen={() => onOpen(n.symbol)} title="Open this book">
            {n.symbol}
          </SymbolLink>,
          "flat",
          "",
          <>
            Position 0 since it started counting: its buys and sells netted out, and the <Money v={n.realized} /> they made is in realized.
          </>,
        ]
      : n.kind === "no-reference"
        ? [
            <SymbolLink key="s" onOpen={() => onOpen(n.symbol)} title="Open this book">
              {n.symbol}
            </SymbolLink>,
            "no reference",
            "bg-accent-soft text-accent",
            <>
              Holds <Signed v={n.position} /> {n.base}, but has no reference price to mark it to yet, so it counts as 0.
            </>,
          ]
        : [
            <span key="s">{n.asset}</span>,
            "outside the books",
            "",
            <>
              The account holds <span className="text-ink">{fmtQty(n.account, 6)}</span>; the books trading it account for <Signed v={n.inBooks} />, so{" "}
              <span className="text-ink">{fmtQty(n.outside, 6)}</span>
              {n.valueUsd !== null && <> ({usd2(n.valueUsd)})</>} was there before they started, or was traded by hand.
            </>,
          ];
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-xs">
      <span className="num w-28 shrink-0 font-medium">{label}</span>
      <span className={cx("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold", tone || "bg-raised text-muted")}>{tag}</span>
      <span className="min-w-0 flex-1 basis-64 text-muted">{why}</span>
    </li>
  );
}

// Cents for bigger figures; under a dollar, enough places that small PnL doesn't read as zero.
function Money({ v }: { v: number }) {
  const a = Math.abs(v);
  const text = a === 0 ? "$0.00" : "$" + a.toLocaleString(undefined, { minimumFractionDigits: a < 1 ? 3 : 2, maximumFractionDigits: a < 1 ? 3 : 2 });
  return <span className={v > 0 ? "text-buy" : v < 0 ? "text-sell" : ""}>{(v > 0 ? "+" : v < 0 ? "−" : "") + text}</span>;
}

function usd2(v: number) {
  return (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Signed({ v }: { v: number }) {
  return <span className={v > 0 ? "text-buy" : v < 0 ? "text-sell" : ""}>{(v > 0 ? "+" : v < 0 ? "−" : "") + fmtQty(Math.abs(v), 6)}</span>;
}

function Bps({ v }: { v: number | null }) {
  if (v === null) return <span className="text-faint">—</span>;
  return <span className={v > 0 ? "text-buy" : v < 0 ? "text-sell" : ""}>{(v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1)} bps</span>;
}

function since(iso: string | null) {
  if (!iso) return "—";
  const t = new Date(iso);
  if (t.getFullYear() < 2000) return "—";
  return t.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
