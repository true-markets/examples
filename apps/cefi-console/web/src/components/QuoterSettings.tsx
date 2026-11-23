import { RotateCcw } from "lucide-react";
import { useState } from "react";
import type { QuoterParams } from "../../../shared/api.ts";
import { useQuoterSettings, useUpdateQuoterSettings } from "../api.ts";
import { validate } from "./Quoter.tsx";
import { Button, cx, inputClass, Panel } from "./ui.tsx";

// The quoter-wide settings (the order rate limits, so far), above the all-books parameter grid.
// They take effect as soon as they're applied and are saved in the quoter's books file, where they
// win over its .env on the next start.
export function QuoterSettings() {
  const q = useQuoterSettings(true);
  const update = useUpdateQuoterSettings();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const data = q.data;
  const cur = (key: string) => (data?.settings[key] === undefined ? "" : String(data.settings[key]));
  const set = (key: string, v: string) =>
    setDraft((d) => {
      const next = { ...d };
      if (v === cur(key)) delete next[key];
      else next[key] = v;
      return next;
    });
  const changed = Object.keys(draft);
  const errorOf = (key: string) => {
    const spec = data?.schema.find((s) => s.key === key);
    return spec && draft[key] !== undefined ? validate(spec, draft[key]!) : undefined;
  };
  const invalid = changed.some((k) => errorOf(k));
  const apply = () => {
    const patch: QuoterParams = {};
    for (const [k, v] of Object.entries(draft)) patch[k] = Number(v);
    update.mutate(patch, { onSuccess: () => setDraft({}) });
  };

  return (
    <Panel
      title="Quoter settings"
      actions={
        <>
          <Button size="xs" tone="ghost" disabled={!changed.length} onClick={() => setDraft({})} title="Drop the changes not yet applied">
            <RotateCcw size={12} /> Reset
          </Button>
          <Button
            size="xs"
            tone="primary"
            disabled={!changed.length || invalid || update.isPending}
            onClick={apply}
            title={invalid ? "Fix the fields in red first" : undefined}
          >
            {update.isPending ? "Applying…" : "Apply"}
          </Button>
        </>
      }
    >
      {!data ? (
        <div className="px-3 py-2 text-xs text-faint">{q.error ? q.error.message : "Loading settings…"}</div>
      ) : (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-2 px-3 pt-1 pb-2 text-xs">
          {data.schema.map((s) => {
            const err = errorOf(s.key);
            return (
              <label key={s.key} className="flex flex-col gap-1" title={s.help}>
                <span className="text-muted">{s.label}</span>
                <span className="flex items-center gap-1.5">
                  <input
                    className={cx(inputClass, "num w-28 text-right", draft[s.key] !== undefined && "border-accent", err && "border-danger")}
                    inputMode="numeric"
                    value={draft[s.key] ?? cur(s.key)}
                    onChange={(e) => set(s.key, e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && changed.length && !invalid && apply()}
                  />
                  {s.unit && <span className="text-faint">{s.unit}</span>}
                </span>
                {err && <span className="text-[11px] text-danger">{err}</span>}
              </label>
            );
          })}
          <p className="max-w-md self-center text-[11px] text-faint">
            Across every book. Changes apply at once and are saved in the quoter&apos;s books file, where they win over its .env on the next start. 0 means no
            limit of the quoter&apos;s own.
          </p>
        </div>
      )}
    </Panel>
  );
}
