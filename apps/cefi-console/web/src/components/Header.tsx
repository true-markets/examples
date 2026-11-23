import { Ban, Monitor, Moon, OctagonX, Pause, Play, Square, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { isActionable, isQuoterOwned, type QuoterOwned } from "../../../shared/orders.ts";
import { useCancelAll, useDemoStrategy, useQuoterControl, useQuoterStatus, useSession, useSetDemoStrategy } from "../api.ts";
import { store, useConn, useOrders } from "../store.ts";
import { useTheme, type Theme } from "../theme.ts";
import { useUi } from "../ui-state.tsx";
import { ConfirmCancel } from "./ConfirmCancel.tsx";
import { Logo } from "./Logo.tsx";
import { Button, cx, Segmented } from "./ui.tsx";

export function Header() {
  const { data: session } = useSession();
  const demo = session?.mode === "demo";
  const strategy = useDemoStrategy(demo);
  const setStrategy = useSetDemoStrategy();
  const orders = useOrders();
  const cancelAll = useCancelAll();
  const [confirm, setConfirm] = useState<"all" | "symbol">();
  // While the quoter is quoting a book, its orders there aren't yours to cancel: it would only
  // put them back. The cancel buttons count, and cancel, everything else; the quoter's own stop
  // buttons pull its quotes.
  const { data: desk } = useQuoterStatus(!!session?.quoter);
  const quoting = desk?.books.filter((b) => b.enabled).map((b) => b.market.symbol) ?? [];
  const keepQuoter: QuoterOwned | undefined = desk?.idPrefix && quoting.length ? { prefix: desk.idPrefix, symbols: quoting } : undefined;
  const actionable = orders.filter((o) => isActionable(o.status));
  const mine = actionable.filter((o) => !isQuoterOwned(o, keepQuoter));
  const quoterOrders = actionable.length - mine.length;
  const open = mine.length;
  // The book that's selected, and your open orders in it.
  const { symbol, view, setView } = useUi();
  const base = symbol?.split("-")[0];
  const openInSymbol = symbol ? mine.filter((o) => o.symbol === symbol).length : 0;
  const quoterNote = keepQuoter ? ` The quoter's ${quoterOrders} resting quote${quoterOrders === 1 ? "" : "s"} stay; Stop and pull pulls those.` : "";

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
      <div className="flex items-center gap-2">
        <Logo size={20} className="text-ink" />
        <span className="text-sm font-semibold">CeFi Console</span>
      </div>
      {session && (
        <span
          className={cx(
            "rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider",
            demo ? "bg-info-soft text-info" : session.environment === "uat" ? "bg-accent-soft text-accent" : "bg-sell-soft text-sell",
          )}
          title={demo ? "Running against the built-in simulator" : `Connected to ${session.environment}`}
        >
          {demo ? "DEMO" : session.environment === "uat" ? "UAT" : "LIVE"}
        </span>
      )}
      {session && (session.accountLabel || session.clientId) && (
        <span className="text-[11px] text-muted" title={session.clientId ? `CeFi client ${session.clientId}` : undefined}>
          {session.accountLabel ?? <span className="num">client {session.clientId}</span>}
        </span>
      )}
      {session?.quoter && (
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: "trading", label: "Trading" },
            { value: "quoter", label: "Quoter" },
          ]}
        />
      )}
      <ConnectionDot />
      {/* Here, well away from "Cancel all orders" on the right. */}
      <ThemeSwitch />

      <div className="ml-auto flex items-center gap-2">
        {demo && strategy.data && (
          <Button onClick={() => setStrategy.mutate(!strategy.data.running)} title="The simulator runs a stand-in strategy that places, moves and cancels orders">
            {strategy.data.running ? <Pause size={13} /> : <Play size={13} />}
            Sim strategy {strategy.data.running ? "running" : "paused"}
          </Button>
        )}
        {/* With the quoter quoting, these show only while there's something besides its quotes. */}
        {symbol && (!keepQuoter || openInSymbol > 0) && (
          <Button tone="danger" size="sm" disabled={openInSymbol === 0} onClick={() => setConfirm("symbol")}
            title={`Cancel every open order you have in ${symbol}${keepQuoter ? ", except the quoter's" : ""}`}>
            <Ban size={13} /> Cancel {base} orders{openInSymbol ? ` (${openInSymbol})` : ""}
          </Button>
        )}
        {(!keepQuoter || open > 0) && (
          <Button tone="danger" size="sm" onClick={() => setConfirm("all")}
            title={keepQuoter ? "Cancel every open order you have, except the quoter's" : "DELETE /v1/cefi/orders/all"}>
            <OctagonX size={14} /> Cancel all orders{open ? ` (${open})` : ""}
          </Button>
        )}
        {session?.quoter && <QuoterStops symbol={symbol} />}
      </div>

      {confirm === "symbol" && symbol && (
        <ConfirmCancel
          title={`Cancel all ${symbol} orders?`}
          body={`Sends a cancel for each of your ${openInSymbol} open ${symbol} order${openInSymbol === 1 ? "" : "s"}, a few at a time. Orders in other books are left alone, and an order can still fill while its cancel is in flight.${quoterNote}`}
          confirmLabel={`Cancel ${base} orders`}
          pending={cancelAll.isPending}
          onClose={() => setConfirm(undefined)}
          onConfirm={() => cancelAll.mutate({ symbol, keepQuoter }, { onSettled: () => setConfirm(undefined) })}
        />
      )}
      {confirm === "all" && (
        <ConfirmCancel
          title="Cancel every open order?"
          body={keepQuoter
            ? `Sends a cancel for each of your ${open} open order${open === 1 ? "" : "s"} in every symbol, a few at a time. An order can still fill while its cancel is in flight.${quoterNote}`
            : `Sends one cancel-all to the exchange for all ${open} of your open orders, in every symbol. Cancels are processed one by one, and an order can still fill while its cancel is in flight. If a strategy is still running it may place new orders afterwards — stop it first.`}
          confirmLabel="Cancel everything"
          pending={cancelAll.isPending}
          onClose={() => setConfirm(undefined)}
          onConfirm={() => cancelAll.mutate({ keepQuoter }, { onSettled: () => setConfirm(undefined) })}
        />
      )}
    </header>
  );
}

// The quoter's stop buttons, on both screens. Stopping a book pulls its quotes and keeps them pulled;
// a plain cancel would only see the quoter put them back on its next cycle.
function QuoterStops({ symbol }: { symbol: string | undefined }) {
  const { data: desk } = useQuoterStatus(true);
  const control = useQuoterControl();
  if (!desk) return null;
  const book = desk.books.find((b) => b.market.symbol === symbol);
  const anyRunning = desk.books.some((b) => b.enabled);
  return (
    <>
      {book && (
        <Button
          tone="danger"
          size="sm"
          disabled={!book.enabled || control.isPending}
          onClick={() => control.mutate({ action: "stop", symbol: book.market.symbol })}
          title={book.enabled ? `Stop the quoter's ${book.market.symbol} book and cancel its resting orders` : `The quoter isn't quoting ${book.market.symbol}`}
        >
          <Square size={12} /> Stop and pull {book.market.baseSymbol} quotes
        </Button>
      )}
      <Button
        tone="danger"
        size="sm"
        disabled={!anyRunning || control.isPending}
        onClick={() => control.mutate({ action: "stop" })}
        title={anyRunning ? "Stop every quoter book and cancel every order the quoter has resting" : "No quoter book is quoting"}
      >
        <Square size={12} /> Stop and pull all quotes
      </Button>
    </>
  );
}

function ConnectionDot() {
  const conn = useConn();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, []);
  // Read live, not from the snapshot: every message moves lastMessageAt without a re-render, and the
  // tick above re-reads it each second.
  const last = store.conn.lastMessageAt;
  const quiet = last ? Math.round((Date.now() - last) / 1000) : undefined;
  const bad = conn.socket !== "open" || conn.auth === "ERROR" || conn.auth === "UNAUTHORIZED";
  const label =
    conn.socket === "connecting" ? "Connecting…" : conn.socket === "closed" ? "Disconnected, retrying" : conn.auth === "AUTHENTICATED" ? "Streaming" : (conn.auth ?? "Open");
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted" title={conn.message ?? `Last message ${quiet ?? "—"}s ago · ${conn.reconnects} reconnects`}>
      <span className={cx("inline-block size-2 rounded-full", bad ? "bg-sell" : quiet !== undefined && quiet > 12 ? "bg-accent" : "bg-buy pulse")} />
      {label}
      {conn.message && <span className="max-w-80 truncate text-sell">· {conn.message}</span>}
    </span>
  );
}

function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const options: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
  ];
  return (
    <div className="inline-flex rounded border border-line bg-raised p-0.5" role="radiogroup" aria-label="Theme">
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={`${label} theme`}
          title={value === "system" ? "Follow the system setting" : `${label} theme`}
          onClick={() => setTheme(value)}
          className={cx("grid h-6 w-7 place-items-center rounded-[3px]", theme === value ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink")}
        >
          <Icon size={13} />
        </button>
      ))}
    </div>
  );
}
