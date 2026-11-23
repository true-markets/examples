import { Columns3, RotateCcw } from "lucide-react";
import { useState } from "react";
import type { QuoterBookSummary, QuoterDeskStatus, QuoterParams, QuoterParamSpec } from "../../../shared/api.ts";
import { useAllQuoterParams, useBulkUpdateQuoterParams } from "../api.ts";
import { applyOp, opAllowed, type BulkOp } from "../bulk-params.ts";
import { quoteUnit } from "../format.ts";
import { validate } from "./Quoter.tsx";
import { Button, cx, Empty, Modal, Panel } from "./ui.tsx";

// Every book's parameters in one grid, opened from the All books bar. Edit any cell, or use the top
// row to set, add to or scale a parameter across the books ticked on the left. Nothing reaches the
// quoter until Apply; each book then takes its own changes (or rejects them) on its next cycle.

const COLS_KEY = "cefi-console:bulk-params-cols";
const DEFAULT_COLS = ["spreadBps", "levels", "levelSpreadMult", "quoteSize", "levelSizeMult", "maxPosition", "skewBps", "modifyThresholdBps"];

function loadCols(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(COLS_KEY) ?? "null");
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : DEFAULT_COLS;
  } catch {
    return DEFAULT_COLS;
  }
}
function saveCols(cols: string[]) {
  try {
    localStorage.setItem(COLS_KEY, JSON.stringify(cols));
  } catch {
    // a private window; the choice lasts until reload
  }
}

// The unit a book reads a parameter in: a size follows the book's sizeUnit.
function unitFor(spec: QuoterParamSpec, b: QuoterBookSummary, params: QuoterParams | undefined): string {
  if (spec.unit === "size") return params?.sizeUnit === "quote" ? quoteUnit(b.market.quoteSymbol) : b.market.baseSymbol;
  if (spec.unit === "quote") return quoteUnit(b.market.quoteSymbol);
  return spec.unit ?? "";
}

export function BulkParams({ d }: { d: QuoterDeskStatus }) {
  const books = d.books;
  const results = useAllQuoterParams(
    books.map((b) => b.market.symbol),
    true,
  );
  const update = useBulkUpdateQuoterParams();
  const schema = results.find((r) => r.data)?.data?.schema;
  const current: Record<string, QuoterParams | undefined> = {};
  books.forEach((b, i) => (current[b.market.symbol] = results[i]?.data?.params));

  const [cols, setColsState] = useState(loadCols);
  const setCols = (c: string[]) => {
    setColsState(c);
    saveCols(c);
  };
  const [picking, setPicking] = useState(false);
  // Edits by book, then by parameter; only what differs from the quoter.
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState(false);
  const isOn = (s: string) => selected[s] ?? true;

  if (!schema) return <Empty>Loading parameters…</Empty>;
  const editable = schema.filter((s) => s.type !== "choice");
  const shown = editable.filter((s) => cols.includes(s.key));

  const curStr = (symbol: string, key: string) => {
    const v = current[symbol]?.[key];
    return v === undefined ? "" : String(v);
  };
  const valueOf = (symbol: string, key: string) => draft[symbol]?.[key] ?? curStr(symbol, key);
  const setCell = (symbol: string, key: string, value: string) =>
    setDraft((dr) => {
      const row = { ...dr[symbol] };
      if (value === curStr(symbol, key)) delete row[key];
      else row[key] = value;
      const next = { ...dr, [symbol]: row };
      if (Object.keys(row).length === 0) delete next[symbol];
      return next;
    });

  const changes = Object.entries(draft).flatMap(([symbol, row]) => Object.keys(row).map((key) => ({ symbol, key })));
  const specOf = (key: string) => schema.find((s) => s.key === key)!;
  const errorOf = (symbol: string, key: string) => (draft[symbol]?.[key] !== undefined ? validate(specOf(key), draft[symbol]![key]!) : undefined);
  const invalid = changes.filter((c) => errorOf(c.symbol, c.key));
  const changedBooks = Object.keys(draft);
  const live = d.environment === "production";

  const apply = () => {
    const patches = changedBooks.map((symbol) => {
      const patch: QuoterParams = {};
      for (const [key, raw] of Object.entries(draft[symbol]!)) {
        const spec = specOf(key);
        patch[key] = spec.type === "boolean" ? raw === "true" : spec.type === "decimal" ? raw.trim() : Number(raw);
      }
      return { symbol, patch };
    });
    update.mutate(patches, {
      // Books that took their changes drop out of the draft; the rest keep theirs to fix and retry.
      onSuccess: (out) =>
        setDraft((dr) => {
          const next = { ...dr };
          for (const r of out) if (!r.error) delete next[r.symbol];
          return next;
        }),
    });
  };

  const ticked = books.filter((b) => isOn(b.market.symbol));
  const allTicked = ticked.length === books.length;

  return (
    <Panel
      title="Parameters · all books"
      className="h-full"
      actions={
        <>
          <Button size="xs" tone="ghost" onClick={() => setPicking(!picking)} aria-pressed={picking} title="Choose which parameters show">
            <Columns3 size={13} /> Columns
          </Button>
          <Button size="xs" tone="ghost" disabled={!changes.length} onClick={() => setDraft({})} title="Drop every change not yet applied">
            <RotateCcw size={12} /> Reset
          </Button>
          <Button
            size="xs"
            tone="primary"
            disabled={!changes.length || invalid.length > 0 || update.isPending}
            onClick={() => (live ? setConfirm(true) : apply())}
            title={invalid.length ? "Fix the cells in red first" : undefined}
          >
            {update.isPending ? "Applying…" : changes.length ? `Apply to ${changedBooks.length} book${changedBooks.length === 1 ? "" : "s"}` : "Apply"}
          </Button>
        </>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        {picking && (
          <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-[11px]">
            {editable.map((s) => (
              <label key={s.key} className="inline-flex items-center gap-1 text-muted">
                <input
                  type="checkbox"
                  checked={cols.includes(s.key)}
                  onChange={(e) => setCols(e.target.checked ? [...cols, s.key] : cols.filter((k) => k !== s.key))}
                />
                {s.label}
              </label>
            ))}
            <button type="button" className="text-muted hover:text-ink hover:underline" onClick={() => setCols(DEFAULT_COLS)}>
              Defaults
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="num w-max min-w-full border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-10 bg-panel text-[10px] font-semibold tracking-wider text-faint uppercase">
              <tr>
                <th className="w-7 border-b border-line px-2 py-1.5 text-left">
                  <input
                    type="checkbox"
                    aria-label="Tick every book"
                    checked={allTicked}
                    onChange={() => setSelected(Object.fromEntries(books.map((b) => [b.market.symbol, !allTicked])))}
                  />
                </th>
                <th className="border-b border-line px-2 py-1.5 text-left">Book</th>
                {shown.map((s) => {
                  const units = [...new Set(books.map((b) => unitFor(s, b, current[b.market.symbol])))].filter(Boolean);
                  return (
                    <th key={s.key} className="border-b border-line px-2 py-1.5 text-right whitespace-nowrap" title={s.help}>
                      {s.label}
                      {units.length > 0 && <span className="ml-1 font-normal tracking-normal normal-case">{units.length === 1 ? units[0] : "mixed"}</span>}
                    </th>
                  );
                })}
              </tr>
              <tr className="bg-raised text-[11px] font-normal tracking-normal normal-case">
                <td className="border-b border-line px-2 py-1" />
                <td className="border-b border-line px-2 py-1 whitespace-nowrap text-muted">
                  {ticked.length} ticked book{ticked.length === 1 ? "" : "s"}
                </td>
                {shown.map((s) => (
                  <td key={s.key} className="border-b border-line px-2 py-1 text-right">
                    <AllRowCell
                      spec={s}
                      units={ticked.map((b) => unitFor(s, b, current[b.market.symbol]))}
                      disabled={ticked.length === 0}
                      onApply={(op, raw) => {
                        for (const b of ticked) {
                          const sym = b.market.symbol;
                          if (s.type === "boolean") {
                            setCell(sym, s.key, raw);
                            continue;
                          }
                          const r = applyOp(s, op, valueOf(sym, s.key), raw);
                          if ("value" in r) setCell(sym, s.key, r.value);
                        }
                      }}
                    />
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              {books.map((b) => {
                const sym = b.market.symbol;
                const loaded = !!current[sym];
                return (
                  <tr key={sym} className={cx(!isOn(sym) && "opacity-60")}>
                    <td className="border-b border-line/60 px-2 py-1">
                      <input
                        type="checkbox"
                        aria-label={`Tick ${sym}`}
                        checked={isOn(sym)}
                        onChange={() => setSelected((x) => ({ ...x, [sym]: !isOn(sym) }))}
                      />
                    </td>
                    <td className="border-b border-line/60 px-2 py-1 font-medium whitespace-nowrap">
                      {sym}
                      {!b.enabled && <span className="ml-1.5 text-[10px] font-normal text-faint">stopped</span>}
                    </td>
                    {shown.map((s) => {
                      const changed = draft[sym]?.[s.key] !== undefined;
                      const err = errorOf(sym, s.key);
                      const unit = unitFor(s, b, current[sym]);
                      return (
                        <td key={s.key} className="border-b border-line/60 px-2 py-1 text-right">
                          {!loaded ? (
                            <span className="text-faint">…</span>
                          ) : s.type === "boolean" ? (
                            <input
                              type="checkbox"
                              aria-label={`${s.label} for ${sym}`}
                              checked={valueOf(sym, s.key) === "true"}
                              onChange={(e) => setCell(sym, s.key, String(e.target.checked))}
                              className={cx(changed && "outline-2 outline-accent")}
                            />
                          ) : (
                            <input
                              value={valueOf(sym, s.key)}
                              onChange={(e) => setCell(sym, s.key, e.target.value)}
                              inputMode="decimal"
                              aria-label={`${s.label} for ${sym}`}
                              title={[changed ? `was ${curStr(sym, s.key)}` : "", unit, err ?? ""].filter(Boolean).join(" · ")}
                              className={cx(
                                "num h-6 w-20 rounded border bg-raised px-1.5 text-right text-xs outline-none focus:border-info",
                                err ? "border-sell bg-sell-soft text-sell" : changed ? "border-accent bg-accent-soft text-accent" : "border-line",
                              )}
                            />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1.5 text-[11px] text-muted">
          {changes.length ? (
            <span>
              <span className="text-accent">{changes.length}</span> change{changes.length === 1 ? "" : "s"} across {changedBooks.length} book
              {changedBooks.length === 1 ? "" : "s"}
              {invalid.length > 0 && <span className="text-sell"> · {invalid.length} to fix</span>}
            </span>
          ) : (
            <span>Edit a cell, or use the top row on the ticked books: = sets the value, + adds to each book's own, × scales it.</span>
          )}
        </div>
      </div>
      {confirm && (
        <Modal
          title={`Change ${changes.length} value${changes.length === 1 ? "" : "s"} across ${changedBooks.length} book${changedBooks.length === 1 ? "" : "s"}?`}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>Not now</Button>
              <Button
                tone="primary"
                onClick={() => {
                  apply();
                  setConfirm(false);
                }}
              >
                Apply
              </Button>
            </>
          }
        >
          <p className="text-xs leading-relaxed text-muted">
            These books quote on the production exchange. Each takes its new parameters on its next cycle: {changedBooks.join(", ")}.
          </p>
        </Modal>
      )}
    </Panel>
  );
}

// The top row's cell for one parameter: pick = + or ×, type a value, press Enter (or the arrow) to
// fill the ticked books' cells. Booleans get On and Off instead.
function AllRowCell({
  spec,
  units,
  disabled,
  onApply,
}: {
  spec: QuoterParamSpec;
  units: string[];
  disabled: boolean;
  onApply: (op: BulkOp, raw: string) => void;
}) {
  const [op, setOp] = useState<BulkOp>("set");
  const [raw, setRaw] = useState("");
  if (spec.type === "boolean") {
    return (
      <span className="inline-flex gap-1">
        {(["true", "false"] as const).map((v) => (
          <button
            key={v}
            type="button"
            disabled={disabled}
            onClick={() => onApply("set", v)}
            className="rounded border border-line px-1.5 text-[11px] text-muted hover:border-faint hover:text-ink disabled:opacity-40"
          >
            {v === "true" ? "On" : "Off"}
          </button>
        ))}
      </span>
    );
  }
  // A column whose books read it in different units starts on ×, the one op that works there.
  const eff: BulkOp = opAllowed(op, units) ? op : "scale";
  const allowed = opAllowed(eff, units);
  const ok = allowed && /^-?\d+(\.\d+)?$/.test(raw.trim()) && !(eff === "scale" && !(Number(raw) > 0));
  const fill = () => {
    if (ok && !disabled) onApply(eff, raw);
  };
  const ops: { op: BulkOp; label: string; title: string }[] = [
    { op: "set", label: "=", title: "Set every ticked book to this value" },
    { op: "add", label: "+", title: "Add this to each ticked book's own value (negative to subtract)" },
    { op: "scale", label: "×", title: "Multiply each ticked book's own value by this" },
  ];
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-flex rounded border border-line">
        {ops.map((o) => {
          const can = opAllowed(o.op, units);
          return (
            <button
              key={o.op}
              type="button"
              disabled={!can}
              onClick={() => setOp(o.op)}
              title={can ? o.title : "These books read this in different units, so only × applies"}
              className={cx("w-5 text-[11px]", eff === o.op ? "bg-panel text-ink" : "text-faint hover:text-ink", !can && "opacity-30")}
            >
              {o.label}
            </button>
          );
        })}
      </span>
      <input
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && fill()}
        placeholder={eff === "scale" ? "1.2" : eff === "add" ? "+/-" : "value"}
        inputMode="decimal"
        disabled={disabled}
        aria-label={`${spec.label}: value to ${eff} on the ticked books`}
        className="num h-6 w-14 rounded border border-line bg-panel px-1.5 text-right text-xs outline-none focus:border-info"
      />
      <button
        type="button"
        disabled={!ok || disabled}
        onClick={fill}
        title={!allowed ? "These books read this in different units, so only × applies" : "Fill the ticked books' cells"}
        className="rounded border border-line px-1 text-[11px] text-muted hover:border-faint hover:text-ink disabled:opacity-40"
      >
        ↓
      </button>
    </span>
  );
}
