import { X } from "lucide-react";
import { createContext, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { OrderStatus, Side } from "../../../shared/wire.ts";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// The far right of the nearest panel header, where a table inside can put its own controls
// (the Columns button) rather than spending a row on them.
export const PanelHeaderSlot = createContext<HTMLElement | null>(null);

// center sits in the middle of the header, between the title and the actions.
export function Panel({
  title,
  actions,
  center,
  children,
  className,
}: {
  title: ReactNode;
  actions?: ReactNode;
  center?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <section className={cx("flex min-h-0 flex-col rounded-md border border-line bg-panel", className)}>
      <header className="relative flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h2>
        {center && <div className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap">{center}</div>}
        <div className="ml-auto flex items-center gap-1.5">
          {actions}
          <span ref={setSlot} className="flex items-center empty:hidden" />
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <PanelHeaderSlot.Provider value={slot}>{children}</PanelHeaderSlot.Provider>
      </div>
    </section>
  );
}

type Tone = "default" | "danger" | "buy" | "sell" | "ghost" | "primary";

export function Button({ tone = "default", size = "sm", className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: "xs" | "sm" | "md" }) {
  const tones: Record<Tone, string> = {
    default: "border-line bg-raised text-ink hover:border-faint",
    ghost: "border-transparent bg-transparent text-muted hover:text-ink hover:bg-raised",
    danger: "border-danger/60 bg-danger/10 text-danger hover:bg-danger/20",
    buy: "border-buy/60 bg-buy text-white hover:brightness-110",
    sell: "border-sell/60 bg-sell text-white hover:brightness-110",
    primary: "border-info/60 bg-info text-white hover:brightness-110",
  };
  const sizes = { xs: "h-6 px-1.5 text-[11px]", sm: "h-7 px-2.5 text-xs", md: "h-9 px-4 text-sm" };
  return (
    <button
      type="button"
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded border font-medium whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-40",
        tones[tone],
        sizes[size],
        className,
      )}
      {...rest}
    />
  );
}

export function SideText({ side }: { side: Side }) {
  return <span className={cx("font-semibold", side === "BUY" ? "text-buy" : "text-sell")}>{side}</span>;
}

const STATUS_TONE: Record<OrderStatus, string> = {
  INITIALIZED: "bg-raised text-muted",
  NEW_PENDING: "bg-info-soft text-info",
  ACTIVE: "bg-info-soft text-info",
  MODIFY_PENDING: "bg-accent-soft text-accent",
  CANCEL_PENDING: "bg-accent-soft text-accent",
  FILLED: "bg-buy-soft text-buy",
  CANCELED: "bg-raised text-muted",
  REJECTED: "bg-sell-soft text-sell",
};

export function StatusBadge({ status, partial }: { status: OrderStatus; partial?: boolean }) {
  const label = status === "ACTIVE" && partial ? "PARTIAL" : status.replace("_", " ");
  return (
    <span className={cx("inline-flex h-5 items-center rounded px-1.5 text-[10px] font-semibold tracking-wide", STATUS_TONE[status])}>
      {(status.endsWith("PENDING") && <span className="pulse mr-1 inline-block size-1.5 rounded-full bg-current" />) || null}
      {label}
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded border border-line bg-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            "h-6 rounded-[3px] px-2 text-[11px] font-medium whitespace-nowrap",
            value === o.value ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    // On a phone it rises from the bottom, full width, short of the top so the page still shows.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 max-md:items-end max-md:p-0" onMouseDown={onClose}>
      <div
        className={cx(
          "flex max-h-full w-full flex-col rounded-lg border border-line bg-panel shadow-2xl max-md:max-h-[85dvh] max-md:max-w-none max-md:rounded-b-none",
          wide ? "max-w-6xl" : "max-w-md",
        )}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-center border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button type="button" className="ml-auto text-muted hover:text-ink" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 space-y-3 overflow-y-auto px-4 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex text-[11px] font-medium text-muted">
        {label}
        {hint && <span className="ml-auto">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export const inputClass =
  "num h-8 w-full rounded border border-line bg-raised px-2 text-ink outline-none placeholder:text-faint focus:border-info";

export const selectClass = "h-7 rounded border border-line bg-raised px-1.5 text-xs text-ink outline-none focus:border-info";

// A symbol or asset that loads its book when clicked. The click stays on the symbol, not the row.
export function SymbolLink({ onOpen, title, className, children }: { onOpen: () => void; title?: string; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className={cx("cursor-pointer text-left hover:text-info hover:underline", className)}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      {children}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-20 items-center justify-center px-4 text-center text-xs text-faint">{children}</div>;
}
