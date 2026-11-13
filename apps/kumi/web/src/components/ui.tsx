import { Check, ChevronRight, Copy, X } from "lucide-react";
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link, type LinkProps } from "react-router";

type Variant = "primary" | "secondary";

const PILL =
  "inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-[22px] px-[18px] text-sm font-medium no-underline disabled:cursor-not-allowed";

const PILL_VARIANT: Record<Variant, string> = {
  primary: "border-0 bg-ink text-white disabled:bg-hairline disabled:text-[#6b727c]",
  secondary: "border border-control bg-white text-ink disabled:text-muted",
};

export function pillClass(variant: Variant = "primary", extra = ""): string {
  return `${PILL} ${PILL_VARIANT[variant]} ${extra}`;
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="button" className={pillClass(variant, className)} {...props} />;
}

export function ButtonLink({ variant = "primary", className = "", ...props }: LinkProps & { variant?: Variant }) {
  return <Link className={pillClass(variant, className)} {...props} />;
}

export function TextButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`min-h-11 cursor-pointer border-0 bg-transparent p-0 text-sm font-medium text-motion underline underline-offset-4 disabled:cursor-default disabled:no-underline ${className}`}
      {...props}
    />
  );
}

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="9.5" cy="10" r="5.5" />
      <circle cx="16.5" cy="10" r="5.5" />
      <circle cx="13" cy="16" r="5.5" />
    </svg>
  );
}

export function SectionLabel({ children, rule = "ink" }: { children: ReactNode; rule?: "ink" | "none" }) {
  return (
    <h2 className={`m-0 pb-2.5 text-sm font-medium text-muted ${rule === "ink" ? "border-b border-ink" : ""}`}>{children}</h2>
  );
}

const DOT: Record<"motion" | "ink" | "error", string> = { motion: "bg-motion", ink: "bg-ink", error: "bg-error" };
const DOT_TEXT: Record<"motion" | "ink" | "error", string> = { motion: "text-motion", ink: "text-ink", error: "text-error" };

export function StatusDot({ tone, children, className = "" }: { tone: "motion" | "ink" | "error"; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${DOT_TEXT[tone]} ${className}`}>
      <span aria-hidden className={`size-[7px] rounded-full ${DOT[tone]}`} />
      {children}
    </span>
  );
}

export function Chevron() {
  return <ChevronRight aria-hidden className="size-4 shrink-0 text-muted" strokeWidth={1.8} />;
}

export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Close"
      className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-[22px] border-0 bg-transparent text-label"
    >
      <X aria-hidden className="size-[18px]" strokeWidth={1.8} />
    </button>
  );
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono ${className}`}>{children}</span>;
}

export function CopyButton({ value, label = "Copy address" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
      className={pillClass("secondary", "h-9 px-3.5 text-sm")}
    >
      {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" className="m-0 py-5 text-sm text-muted">
      {label}
    </p>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="m-0 py-5 text-sm text-error">
      {children}
    </p>
  );
}

export function DetailRows({ rows }: { rows: { k: string; v: ReactNode; mono?: boolean }[] }) {
  return (
    <dl className="m-0 flex flex-col text-sm">
      {rows.map((row) => (
        <div key={row.k} className="flex justify-between gap-4 border-b border-hairline px-1 py-3">
          <dt className="text-muted">{row.k}</dt>
          <dd className={`m-0 text-right ${row.mono ? "font-mono" : ""}`}>{row.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Breadcrumb({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-sm text-muted">
      {items.map((item, i) => (
        <span key={item.label + i} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden>/</span>}
          {item.to ? (
            <Link to={item.to} className="flex min-h-11 items-center text-muted no-underline hover:text-ink">
              {item.label}
            </Link>
          ) : (
            <span className="text-ink">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function AssetLogo({ symbol, icon, size = 24 }: { symbol: string; icon?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size };
  if (icon && !failed) {
    return (
      <img
        src={icon}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        style={box}
        className="shrink-0 rounded-full bg-hairline object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ ...box, fontSize: Math.max(9, Math.round(size * 0.38)) }}
      className="flex shrink-0 items-center justify-center rounded-full border border-hairline bg-segment font-medium text-label"
    >
      {symbol.slice(0, 2)}
    </span>
  );
}

export function ShareBar({ segments }: { segments: { key: string; pct: number; color: string }[] }) {
  return (
    <div aria-hidden className="flex h-2.5 overflow-hidden rounded-full bg-hairline">
      {segments.map((s) => (
        <span key={s.key} className="block border-r-2 border-paper last:border-r-0" style={{ width: `${s.pct}%`, background: s.color }} />
      ))}
    </div>
  );
}

export function useEscape(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, enabled]);
}

// The right-hand dialog the trade, withdraw and transfer flows share. Escape is ignored while `busy`.
export function SidePanel({
  titleId,
  title,
  subtitle,
  onClose,
  busy = false,
  children,
}: {
  titleId: string;
  title: string;
  subtitle: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
}) {
  useEscape(onClose, !busy);
  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-[rgba(12,15,20,.24)]">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="box-border flex w-full max-w-[440px] flex-col gap-7 overflow-y-auto border-l border-hairline bg-white px-7 pt-5 pb-7 shadow-[-24px_0_64px_rgba(12,15,20,.12)]"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 id={titleId} className="m-0 text-[17px] font-semibold tracking-[-0.01em]">
              {title}
            </h2>
            <span className="text-sm text-muted">{subtitle}</span>
          </div>
          <CloseButton onClick={onClose} />
        </div>
        {children}
      </section>
    </div>
  );
}
