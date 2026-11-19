// Nanosecond strings to milliseconds; precision past the millisecond is dropped for display only.
export function nsToMs(ns: string | undefined): number {
  if (!ns) return 0;
  return ns.length > 6 ? Number(ns.slice(0, -6)) : 0;
}

export function time(ns: string | undefined): string {
  const ms = nsToMs(ns);
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// Short enough for a narrow column: "22:30:13" today, "Nov 18 22:30" on another day.
export function when(ns: string | undefined): string {
  const ms = nsToMs(ns);
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date().toDateString()) return `${hm}:${pad(d.getSeconds())}`;
  return `${d.toLocaleString(undefined, { month: "short" })} ${d.getDate()} ${hm}`;
}

export function dateTime(ns: string | undefined): string {
  const ms = nsToMs(ns);
  return ms ? new Date(ms).toLocaleString() : "—";
}

// toLocaleString(…, options) builds a new Intl.NumberFormat on every call, which is slow enough to
// matter when a table re-renders. Formatters are built once per option set and reused.
const formatters = new Map<string, Intl.NumberFormat>();
function fmt(n: number, opts: Intl.NumberFormatOptions): string {
  const key = JSON.stringify(opts);
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.NumberFormat(undefined, opts)));
  return f.format(n);
}

// Shows a decimal string as given, trimming only trailing zeros past the point.
export function qty(v: string | number | undefined, maxDecimals = 8): string {
  if (v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return fmt(n, { maximumFractionDigits: maxDecimals });
}

export function price(v: string | number | undefined, decimals?: number): string {
  if (v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n === 0) return "—";
  // A computed number (a spread, a mid) carries float noise, so it needs an explicit precision.
  const max = decimals ?? (typeof v === "number" ? 6 : Math.min(10, Math.max(2, decimalsOf(v))));
  return fmt(n, { minimumFractionDigits: Math.min(decimals ?? 2, max), maximumFractionDigits: max });
}

export function usd(v: number): string {
  return fmt(v, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export function compact(v: string | number | undefined): string {
  const n = Number(v ?? 0);
  return fmt(n, { notation: "compact", maximumFractionDigits: 2 });
}

export function decimalsOf(s: string): number {
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

export function shortId(id: string | undefined): string {
  if (!id) return "—";
  return id.length > 10 ? `…${id.slice(-8)}` : id;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
