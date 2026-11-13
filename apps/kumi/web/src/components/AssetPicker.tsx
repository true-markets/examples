import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { tokenAmount, unitPrice } from "../format.ts";
import type { AssetRow } from "../types.ts";
import { AssetLogo } from "./ui.tsx";

interface Props {
  assets: readonly AssetRow[];
  value: string;
  // What the household holds of each asset, by symbol, so held assets lead the list.
  held: Record<string, string>;
  onChange: (symbol: string) => void;
}

const isHeld = (amount: string | undefined) => Number(amount ?? 0) > 0;

// A heading opens each group: held assets first, then the rest.
const groupLabel = (index: number, heldCount: number) => (index === 0 && heldCount > 0 ? "Held" : index === heldCount ? "All assets" : null);

export function AssetPicker({ assets, value, held, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = assets.find((a) => a.symbol === value);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets.filter((a) => !q || a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
  }, [assets, query]);
  const rows = useMemo(
    () => [...matches.filter((a) => isHeld(held[a.symbol])), ...matches.filter((a) => !isHeld(held[a.symbol]))],
    [matches, held],
  );

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function close() {
    setOpen(false);
    setQuery("");
    setActive(0);
  }

  function choose(symbol: string) {
    onChange(symbol);
    close();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      // The trade panel closes on Escape too; this keeps it open while the list is.
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter" && rows[active]) {
      event.preventDefault();
      choose(rows[active]!.symbol);
    }
  }

  const heldCount = rows.filter((a) => isHeld(held[a.symbol])).length;

  return (
    <div ref={root} className="relative w-full" onKeyDown={onKeyDown}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-label={`Asset to trade: ${selected?.name ?? value}`}
        onClick={() => setOpen(!open)}
        className="flex h-12 w-full cursor-pointer items-center gap-3 rounded-xl border border-control bg-white pr-4 pl-3 text-base font-medium text-ink"
      >
        <AssetLogo symbol={value} icon={selected?.icon} size={24} />
        <span>{value}</span>
        <span className="font-normal text-muted">{selected?.name}</span>
        <span className="flex-1" />
        <ChevronDown aria-hidden className="size-4 text-muted" />
      </button>

      {open && (
        <div className="absolute top-14 right-0 left-0 z-30 overflow-hidden rounded-2xl border border-hairline bg-white shadow-[0_16px_40px_rgba(12,15,20,.16)]">
          <label className="flex items-center gap-2.5 border-b border-hairline px-4">
            <Search aria-hidden className="size-4 text-muted" />
            <input
              ref={search}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              placeholder="Search assets"
              aria-label="Search assets"
              className="h-12 min-w-0 flex-1 border-0 bg-transparent text-base text-ink outline-none placeholder:text-muted"
            />
          </label>
          <ul id={listId} role="listbox" aria-label="Assets" className="m-0 max-h-[340px] list-none overflow-y-auto p-1.5">
            {rows.length === 0 && <li className="px-3 py-4 text-sm text-muted">No asset matches "{query}".</li>}
            {rows.map((asset, i) => (
              <li key={asset.symbol} role="presentation">
                {groupLabel(i, heldCount) && (
                  <div className="px-3 pt-2 pb-1 text-[13px] font-medium tracking-wide text-muted uppercase">{groupLabel(i, heldCount)}</div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={asset.symbol === value}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(asset.symbol)}
                  className={`flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-xl border-0 px-3 text-left ${
                    i === active ? "bg-paper" : "bg-transparent"
                  }`}
                >
                  <AssetLogo symbol={asset.symbol} icon={asset.icon} size={32} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-base font-medium text-ink">{asset.symbol}</span>
                    <span className="truncate text-sm text-muted">{asset.name}</span>
                  </span>
                  <span className="flex flex-col items-end">
                    <span className="text-sm text-ink">{unitPrice(asset.price)}</span>
                    {isHeld(held[asset.symbol]) && (
                      <span className="text-sm text-muted">{tokenAmount(held[asset.symbol]!, asset.symbol)}</span>
                    )}
                  </span>
                  {asset.symbol === value && <Check aria-hidden className="size-4 text-ink" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
