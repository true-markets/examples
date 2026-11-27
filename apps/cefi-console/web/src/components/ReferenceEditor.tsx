import { CircleAlert, Plus, Trash2, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { QuoterBlend, QuoterReferencePreview, QuoterSource, QuoterSourceView } from "../../../shared/api.ts";
import { useQuoterPreview, useQuoterSuggest } from "../api.ts";
import { price as fmtPrice, quoteUnit, usd as fmtUsd } from "../format.ts";
import { Help } from "./help.tsx";
import { Button, cx, inputClass, Modal, selectClass } from "./ui.tsx";

// Setting up a book's reference price: which sources it blends, how much each counts, and the
// multiplier that lines each one up. Every change is previewed against live prices from the
// quoter (nothing is saved until you press the button), with each source's raw and adjusted price,
// how far it sits from the others, its share of the blend, and anything that looks like a
// corporate action: a source trading a whole multiple of the others (an unadjusted split), or
// out of line by some other ratio (a share multiplier). Those come with the multiplier that would
// fix them, one click away.

// inputClass fills its container; these inputs set their own width.
const sizedInput = inputClass.replace("w-full", "");

// A source as edited: numbers stay text until they're sent.
interface Row {
  ref: string;
  weight: string;
  multiplier: string;
}

export function describeSource(ref: string): string {
  if (ref.startsWith("hyperliquid:")) return `Hyperliquid ${ref.slice("hyperliquid:".length)}`;
  if (ref.startsWith("kraken:")) return `Kraken ${ref.slice("kraken:".length)}`;
  return `Coinbase ${ref}`;
}

export function describeBlend(b: QuoterBlend | undefined, fallback: string): string {
  const used = b?.sources.filter((s) => s.weight > 0) ?? [];
  if (used.length === 0) return describeSource(fallback);
  return used.map((s) => describeSource(s.ref)).join(" + ");
}

const toRows = (b: QuoterBlend): Row[] => b.sources.map((s) => ({ ref: s.ref, weight: String(s.weight), multiplier: s.multiplier ?? "1" }));

// rowsToBlend turns the form into a blend, or says what's wrong with it.
function rowsToBlend(rows: Row[], weighting: string, maxDev: string, tokenMult: string): QuoterBlend | string {
  if (rows.length === 0) return "add at least one source";
  const sources: QuoterSource[] = [];
  for (const r of rows) {
    const w = Number(r.weight);
    if (r.weight.trim() === "" || !Number.isFinite(w) || w < 0) return `${describeSource(r.ref)}: weight must be 0 or more`;
    const m = Number(r.multiplier);
    if (!Number.isFinite(m) || m <= 0) return `${describeSource(r.ref)}: multiplier must be above 0`;
    sources.push({ ref: r.ref, weight: w, multiplier: r.multiplier.trim() || "1" });
  }
  if (!sources.some((s) => s.weight > 0)) return "at least one source needs a weight above 0";
  const dev = Number(maxDev);
  if (!Number.isFinite(dev) || dev < 5 || dev > 5000) return "max deviation must be 5 to 5000 bps";
  const tm = Number(tokenMult);
  if (!Number.isFinite(tm) || tm <= 0) return "token multiplier must be above 0";
  return { sources, weighting: weighting as QuoterBlend["weighting"], maxDeviationBps: dev, tokenMultiplier: tokenMult.trim() || "1" };
}

// useDebounced holds a value back until it has stopped changing for a moment, so typing a weight
// doesn't fire a preview per keystroke.
function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ReferenceEditor({
  symbol,
  initial,
  fallbackRef,
  title,
  saveLabel,
  saving,
  onSave,
  onClose,
}: {
  symbol: string;
  initial?: QuoterBlend; // an existing book's blend; a new book starts from the suggested sources
  fallbackRef: string; // the listing's default, if nothing is suggested
  title: string;
  saveLabel: string;
  saving: boolean;
  onSave: (b: QuoterBlend) => void;
  onClose: () => void;
}) {
  const suggest = useQuoterSuggest(symbol);
  const suggested = suggest.data?.sources ?? [];
  const [rows, setRows] = useState<Row[] | null>(initial ? toRows(initial) : null);
  const [weighting, setWeighting] = useState<string>(initial?.weighting ?? "fixed");
  const [maxDev, setMaxDev] = useState(String(initial?.maxDeviationBps ?? 100));
  const [tokenMult, setTokenMult] = useState(initial?.tokenMultiplier ?? "1");
  const [adding, setAdding] = useState("");

  // A new book starts from what the quoter found, once it has answered.
  useEffect(() => {
    if (rows !== null || suggest.isLoading) return;
    const start = suggested.length > 0 ? suggested : fallbackRef ? [{ ref: fallbackRef, weight: 1 }] : [];
    setRows(start.map((s) => ({ ref: s.ref, weight: String(s.weight), multiplier: s.multiplier ?? "1" })));
  }, [rows, suggest.isLoading, suggested, fallbackRef]);

  const list = useMemo(() => rows ?? [], [rows]);
  const blend = useMemo(() => rowsToBlend(list, weighting, maxDev, tokenMult), [list, weighting, maxDev, tokenMult]);
  const valid = typeof blend === "string" ? undefined : blend;
  const debounced = useDebounced(valid);
  const preview = useQuoterPreview(symbol, debounced);
  const view = preview.data;

  const set = (i: number, patch: Partial<Row>) => setRows(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addSource = (ref: string, weight = "1") => {
    const r = ref.trim();
    if (!r || list.some((x) => x.ref.toLowerCase() === r.toLowerCase())) return;
    setRows([...list, { ref: r, weight, multiplier: "1" }]);
  };
  const missing = suggested.filter((s) => !list.some((r) => r.ref === s.ref));

  return (
    <Modal
      wide
      title={title}
      onClose={onClose}
      footer={
        <>
          {typeof blend === "string" && <span className="mr-auto self-center text-xs text-danger">{blend}</span>}
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" disabled={!valid || saving} onClick={() => valid && onSave(valid)}>
            {saveLabel}
          </Button>
        </>
      }
    >
      <Help>
        <p className="text-xs leading-relaxed text-muted">
          The book quotes around a weighted average of these sources. Each source's <b>multiplier</b> turns its price into the price of one share (1 unless it
          quotes something else); the <b>token multiplier</b> turns the price of a share into the price of one {symbol.split("-")[0]} token. A source too far
          from the others is left out of the price until it comes back; weight 0 watches a source without using it. The preview is live and nothing is saved
          until you press {saveLabel}.
        </p>
      </Help>

      <SourcesTable
        rows={list}
        view={view}
        loading={rows === null}
        onChange={set}
        onRemove={(i) => setRows(list.filter((_, j) => j !== i))}
        onApplyMultiplier={(ref, m) => setRows(list.map((r) => (r.ref === ref ? { ...r, multiplier: m } : r)))}
      />

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            addSource(adding);
            setAdding("");
          }}
        >
          <input
            className={cx(sizedInput, "h-7 w-72")}
            placeholder="BTC-USD, hyperliquid:xyz:GOOGL, kraken:GOOGLx/USD"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            aria-label="Source to add"
          />
          <Button size="xs" type="submit" disabled={!adding.trim()}>
            <Plus size={12} /> Add source
          </Button>
        </form>
        {suggest.isLoading && <span className="text-faint">looking for sources…</span>}
        {missing.map((s) => (
          <Button
            key={s.ref}
            size="xs"
            tone="ghost"
            onClick={() => addSource(s.ref, String(s.weight))}
            title={s.weight === 0 ? "suggested to watch: weight 0" : undefined}
          >
            <Plus size={12} /> {describeSource(s.ref)}
            {s.weight === 0 && <span className="text-faint"> (watch)</span>}
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-[11px] text-muted">Weighting</span>
          <select className={cx(selectClass, "w-full")} value={weighting} onChange={(e) => setWeighting(e.target.value)}>
            <option value="fixed">Fixed: each source's weight as set</option>
            <option value="depth">By depth: weight × dollars at the touch</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-muted">Max deviation (bps): leave out a source this far from the others</span>
          <input className={cx(inputClass, "h-7")} value={maxDev} onChange={(e) => setMaxDev(e.target.value)} inputMode="decimal" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-muted">Token multiplier: shares per {symbol.split("-")[0]} token</span>
          <input className={cx(inputClass, "h-7")} value={tokenMult} onChange={(e) => setTokenMult(e.target.value)} inputMode="decimal" />
        </label>
      </div>

      <Result view={view} error={preview.error?.message} pending={!view && !!valid} quote={quoteUnit(symbol.split("-")[1] ?? "")} onApplyToken={setTokenMult} />
    </Modal>
  );
}

function stateTone(s: QuoterSourceView["state"]) {
  switch (s) {
    case "in":
      return "bg-buy-soft text-buy";
    case "watch":
      return "bg-info/15 text-info";
    case "out":
      return "bg-danger/15 text-danger";
    default:
      return "bg-raised text-muted";
  }
}

function SourcesTable({
  rows,
  view,
  loading,
  onChange,
  onRemove,
  onApplyMultiplier,
}: {
  rows: Row[];
  view?: QuoterReferencePreview;
  loading: boolean;
  onChange: (i: number, patch: Partial<Row>) => void;
  onRemove: (i: number) => void;
  onApplyMultiplier: (ref: string, m: string) => void;
}) {
  const th = "px-1.5 py-1.5 font-medium text-right";
  const thL = "px-1.5 py-1.5 font-medium text-left";
  const td = "px-1.5 py-1 text-right";
  const byRef = new Map(view?.blend.sources.map((s) => [s.ref, s]));
  return (
    <div className="overflow-x-auto rounded border border-line">
      <table className="num w-full min-w-[900px] text-xs">
        <thead className="bg-raised text-[11px] text-muted">
          <tr>
            <th className={thL}>Source</th>
            <th className={thL}>State</th>
            <th className={th}>Weight</th>
            <th className={th}>Multiplier</th>
            <th className={th} title="As the source quotes it">
              Bid / Ask
            </th>
            <th className={th}>Mid</th>
            <th className={th} title="Mid × multiplier: the price of one share by this source">
              Adjusted
            </th>
            <th className={th}>Spread</th>
            <th className={th} title="The smaller side at the touch, in dollars">
              Depth
            </th>
            <th className={th} title="Adjusted price against the other sources">
              vs others
            </th>
            <th className={th} title="This source's part of the blended price">
              Share
            </th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">
          {loading && (
            <tr>
              <td colSpan={12} className="px-2 py-3 text-center text-faint">
                Looking for sources…
              </td>
            </tr>
          )}
          {rows.map((r, i) => {
            const v = byRef.get(r.ref);
            const gap = v?.gapBps;
            const flagged = v?.action && v.action.kind !== "drift" ? v.action : undefined;
            return (
              <SourceRows
                key={r.ref}
                span={12}
                note={v?.action ? v.action : undefined}
                onApply={() => v?.action && onApplyMultiplier(r.ref, v.action.multiplier)}
              >
                <td className="px-1.5 py-1 text-left">
                  <div>{describeSource(r.ref)}</div>
                  <div className="text-[10px] text-faint">{r.ref}</div>
                </td>
                <td className="px-1.5 py-1 text-left">
                  <span
                    className={cx(
                      "inline-flex h-5 items-center rounded px-1.5 text-[10px] font-bold uppercase tracking-wider",
                      stateTone(v?.state ?? "waiting"),
                    )}
                    title={v?.note}
                  >
                    {v?.state ?? "…"}
                  </span>
                  {v?.note && !flagged && <div className="max-w-40 truncate text-[10px] text-faint">{v.note}</div>}
                </td>
                <td className={td}>
                  <input
                    className={cx(sizedInput, "h-7 w-16 text-right")}
                    value={r.weight}
                    onChange={(e) => onChange(i, { weight: e.target.value })}
                    inputMode="decimal"
                    aria-label={`${r.ref} weight`}
                  />
                </td>
                <td className={td}>
                  <input
                    className={cx(sizedInput, "h-7 w-24 text-right")}
                    value={r.multiplier}
                    onChange={(e) => onChange(i, { multiplier: e.target.value })}
                    inputMode="decimal"
                    aria-label={`${r.ref} multiplier`}
                  />
                </td>
                <td className={td}>
                  {v?.bid ? (
                    <>
                      <span className="text-buy">{fmtPrice(v.bid)}</span> / <span className="text-sell">{fmtPrice(v.ask ?? "")}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className={td}>{v?.mid ? fmtPrice(v.mid) : "—"}</td>
                <td className={cx(td, "font-semibold")}>{v?.adjusted ? fmtPrice(v.adjusted) : "—"}</td>
                <td className={td}>{v?.spreadBps != null ? `${v.spreadBps.toFixed(1)} bps` : "—"}</td>
                <td className={td}>{v?.depthUsd ? fmtUsd(Number(v.depthUsd)) : "—"}</td>
                <td
                  className={cx(
                    td,
                    gap != null && Math.abs(gap) > (view?.blend.maxDeviationBps ?? 100)
                      ? "text-danger"
                      : gap != null && Math.abs(gap) >= 25
                        ? "text-accent"
                        : "",
                  )}
                >
                  {gap != null ? `${gap > 0 ? "+" : ""}${gap.toFixed(1)} bps` : "—"}
                </td>
                <td className={td}>{v && v.share > 0 ? `${(v.share * 100).toFixed(1)}%` : "—"}</td>
                <td className="px-1 text-right">
                  <Button size="xs" tone="ghost" onClick={() => onRemove(i)} aria-label={`Remove ${r.ref}`}>
                    <Trash2 size={12} />
                  </Button>
                </td>
              </SourceRows>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// One source's row, and under it what its price ratio suggests (a split, a multiplier, a drift),
// with the fix.
function SourceRows({
  children,
  note,
  span,
  onApply,
}: {
  children: React.ReactNode;
  note?: { kind: string; text: string; multiplier: string };
  span: number;
  onApply: () => void;
}) {
  return (
    <>
      <tr>{children}</tr>
      {note && (
        <tr>
          <td colSpan={span} className={cx("px-2 pb-1.5 text-[11px]", note.kind === "drift" ? "text-faint" : "text-accent")}>
            <span className="inline-flex items-start gap-1.5">
              <CircleAlert size={12} className="mt-0.5 shrink-0" />
              <span>
                {note.kind === "split" ? "Likely split: " : note.kind === "multiplier" ? "Out of line: " : "Drift: "}
                {note.text}
              </span>
              <Button size="xs" tone="ghost" onClick={onApply} title="Set this source's multiplier to line it up">
                <Wand2 size={12} /> Use {note.multiplier}
              </Button>
            </span>
          </td>
        </tr>
      )}
    </>
  );
}

function Result({
  view,
  error,
  pending,
  quote,
  onApplyToken,
}: {
  view?: QuoterReferencePreview;
  error?: string;
  pending: boolean;
  quote: string;
  onApplyToken: (m: string) => void;
}) {
  if (error) return <div className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>;
  if (!view) return <div className="text-xs text-faint">{pending ? "Pricing…" : ""}</div>;
  const b = view.blend;
  const tm = Number(b.tokenMultiplier);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded border border-line bg-raised/40 px-3 py-2 text-xs sm:grid-cols-4">
        <Stat label={`Blended, per share (${b.used} source${b.used === 1 ? "" : "s"}, ${b.weighting})`}>{b.perShare ? fmtPrice(b.perShare) : "—"}</Stat>
        <Stat label="× token multiplier">{tm === 1 ? "1" : b.tokenMultiplier}</Stat>
        <Stat label={`Fair value, ${quote} per token`}>
          <span className="font-semibold">{b.mid ? fmtPrice(b.mid) : "—"}</span>
          {b.bid && b.ask && (
            <span className="text-faint">
              {" "}
              <span className="text-buy">{fmtPrice(b.bid)}</span> / <span className="text-sell">{fmtPrice(b.ask)}</span>
            </span>
          )}
        </Stat>
        <Stat label="The book on True Markets">
          {view.bookMid ? (
            <>
              {fmtPrice(view.bookMid)}{" "}
              {view.bookGapBps != null && (
                <span className={Math.abs(view.bookGapBps) > 200 ? "text-danger" : "text-faint"}>
                  ({view.bookGapBps > 0 ? "+" : ""}
                  {view.bookGapBps.toFixed(0)} bps)
                </span>
              )}
            </>
          ) : (
            <span className="text-faint">shown once the book is added</span>
          )}
        </Stat>
      </div>
      {b.problem && <div className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">No price: {b.problem}</div>}
      {view.warnings.map((w) => (
        <div key={w} className="flex items-start gap-2 rounded border border-accent/40 bg-accent-soft px-3 py-2 text-xs text-accent">
          <CircleAlert size={12} className="mt-0.5 shrink-0" />
          <span className="flex-1">{w}</span>
          {view.tokenMultiplier && w.includes("token multiplier") && (
            <Button size="xs" tone="ghost" onClick={() => onApplyToken(view.tokenMultiplier!)}>
              <Wand2 size={12} /> Use {view.tokenMultiplier}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="num">{children}</div>
    </div>
  );
}
