import { useState } from "react";
import { cx } from "../components/ui.tsx";
import { isActive, type FilterMeta, type FilterValue, type RangeValue, type SinceValue } from "./filters.ts";

export interface Facet {
  value: string;
  count: number;
}

const input = "num h-7 w-full rounded border border-line bg-raised px-2 text-ink outline-none placeholder:text-faint focus:border-info";
const opSelect = "h-7 rounded border border-line bg-raised px-1 text-ink outline-none focus:border-info";

// The editor for one column's filter. Changes apply as you type; an empty editor clears the filter.
export function FilterEditor({
  label,
  meta,
  value,
  onChange,
  facets,
}: {
  label: string;
  meta: FilterMeta;
  value: FilterValue | undefined;
  onChange: (v: FilterValue | undefined) => void;
  facets?: Facet[];
}) {
  const set = (v: FilterValue) => onChange(isActive(meta.kind, v) ? v : undefined);
  return (
    <div className="space-y-2">
      <div className="flex items-center">
        <span className="font-semibold text-ink">{label}</span>
        <button type="button" className="ml-auto text-[11px] text-info hover:underline disabled:opacity-40" disabled={!isActive(meta.kind, value)} onClick={() => onChange(undefined)}>
          Clear
        </button>
      </div>
      {meta.kind === "range" && <RangeEditor meta={meta} value={value as RangeValue | undefined} onChange={set} />}
      {meta.kind === "multi" && <MultiEditor value={(value as string[] | undefined) ?? []} onChange={set} facets={facets ?? []} />}
      {meta.kind === "text" && (
        <input className={input} autoFocus placeholder={`${label} contains…`} value={(value as string | undefined) ?? ""} onChange={(e) => set(e.target.value)} />
      )}
      {meta.kind === "since" && <SinceEditor value={value as SinceValue | undefined} onChange={set} />}
    </div>
  );
}

// Either bound, or both for a band. Bounds are kept as typed so "20." doesn't snap back to "20".
function RangeEditor({ meta, value, onChange }: { meta: FilterMeta; value: RangeValue | undefined; onChange: (v: RangeValue) => void }) {
  const [minText, setMinText] = useState(value?.min?.toString() ?? "");
  const [maxText, setMaxText] = useState(value?.max?.toString() ?? "");
  const minOp = value?.minOp ?? ">";
  const maxOp = value?.maxOp ?? "<";
  const parse = (t: string) => (t.trim() === "" || Number.isNaN(Number(t)) ? undefined : Number(t));
  const emit = (patch: Partial<RangeValue>) => onChange({ min: parse(minText), max: parse(maxText), minOp, maxOp, ...patch });
  const unit = meta.unit === "$" ? "$" : "";
  const suffix = meta.unit === "%" ? "%" : "";
  const row = (which: "min" | "max") => (
    <div className="flex items-center gap-1.5">
      <select
        className={opSelect}
        value={which === "min" ? minOp : maxOp}
        onChange={(e) => emit(which === "min" ? { minOp: e.target.value as RangeValue["minOp"] } : { maxOp: e.target.value as RangeValue["maxOp"] })}
        aria-label={which === "min" ? "Lower bound" : "Upper bound"}
      >
        {which === "min" ? (
          <>
            <option value=">">&gt;</option>
            <option value=">=">≥</option>
          </>
        ) : (
          <>
            <option value="<">&lt;</option>
            <option value="<=">≤</option>
          </>
        )}
      </select>
      {unit && <span className="text-muted">{unit}</span>}
      <input
        className={input}
        inputMode="decimal"
        autoFocus={which === "min"}
        placeholder={which === "min" ? "no lower bound" : "no upper bound"}
        value={which === "min" ? minText : maxText}
        onChange={(e) => {
          const t = e.target.value;
          if (which === "min") setMinText(t);
          else setMaxText(t);
          emit(which === "min" ? { min: parse(t) } : { max: parse(t) });
        }}
      />
      {suffix && <span className="text-muted">{suffix}</span>}
    </div>
  );
  return (
    <div className="space-y-1.5">
      {row("min")}
      {row("max")}
      <p className="text-[10px] text-faint">Set one bound, or both for a band.</p>
    </div>
  );
}

// Any of the chosen values. Counts are over all rows, before other filters.
function MultiEditor({ value, onChange, facets }: { value: string[]; onChange: (v: string[]) => void; facets: Facet[] }) {
  const [search, setSearch] = useState("");
  const shown = facets.filter((f) => f.value.toLowerCase().includes(search.trim().toLowerCase()));
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="space-y-1.5">
      {facets.length > 8 && <input className={input} autoFocus placeholder="Find…" value={search} onChange={(e) => setSearch(e.target.value)} />}
      <div className="flex gap-2 text-[11px]">
        <button type="button" className="text-info hover:underline" onClick={() => onChange([...new Set([...value, ...shown.map((f) => f.value)])])}>
          Select all{search ? " shown" : ""}
        </button>
        <button type="button" className="text-info hover:underline" onClick={() => onChange([])}>
          None
        </button>
      </div>
      <div className="max-h-56 space-y-0.5 overflow-y-auto">
        {shown.map((f) => (
          <label key={f.value} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-raised">
            <input type="checkbox" checked={value.includes(f.value)} onChange={() => toggle(f.value)} />
            <span className="truncate text-ink">{f.value || "—"}</span>
            <span className="num ml-auto text-faint">{f.count}</span>
          </label>
        ))}
        {shown.length === 0 && <p className="px-1 text-faint">No values.</p>}
      </div>
    </div>
  );
}

const PRESETS = [1, 5, 15, 60, 240, 1440];

function SinceEditor({ value, onChange }: { value: SinceValue | undefined; onChange: (v: SinceValue) => void }) {
  const [custom, setCustom] = useState(value && !PRESETS.includes(value.minutes) ? String(value.minutes) : "");
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted">Within the last</p>
      <div className="grid grid-cols-3 gap-1">
        {PRESETS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setCustom("");
              onChange({ minutes: m });
            }}
            className={cx("h-7 rounded border text-[11px]", value?.minutes === m ? "border-info bg-info-soft text-info" : "border-line bg-raised text-ink hover:border-faint")}
          >
            {m < 60 ? `${m} min` : `${m / 60} h`}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          className={input}
          inputMode="numeric"
          placeholder="or minutes"
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            const n = Number(e.target.value);
            onChange({ minutes: n > 0 ? n : 0 });
          }}
        />
        <span className="text-muted">min</span>
      </div>
    </div>
  );
}
