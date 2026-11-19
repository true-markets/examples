import { Ban, Monitor, Moon, OctagonX, Pause, Play, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { isActionable } from "../../../shared/orders.ts";
import { useCancelAll, useDemoStrategy, useSession, useSetDemoStrategy } from "../api.ts";
import { useConn, useOrders } from "../store.ts";
import { useTheme, type Theme } from "../theme.ts";
import { useUi } from "../ui-state.tsx";
import { ConfirmCancel } from "./ConfirmCancel.tsx";
import { Logo } from "./Logo.tsx";
import { Button, cx } from "./ui.tsx";

export function Header() {
  const { data: session } = useSession();
  const demo = session?.mode === "demo";
  const strategy = useDemoStrategy(demo);
  const setStrategy = useSetDemoStrategy();
  const orders = useOrders();
  const cancelAll = useCancelAll();
  const [confirm, setConfirm] = useState<"all" | "symbol">();
  const open = orders.filter((o) => isActionable(o.status)).length;
  // The book that's selected, and your open orders in it.
  const { symbol } = useUi();
  const base = symbol?.split("-")[0];
  const openInSymbol = symbol ? orders.filter((o) => o.symbol === symbol && isActionable(o.status)).length : 0;

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
        {symbol && (
          <Button tone="danger" size="sm" disabled={openInSymbol === 0} onClick={() => setConfirm("symbol")} title={`Cancel every open order you have in ${symbol}`}>
            <Ban size={13} /> Cancel {base} orders{openInSymbol ? ` (${openInSymbol})` : ""}
          </Button>
        )}
        <Button tone="danger" size="sm" onClick={() => setConfirm("all")} title="DELETE /v1/cefi/orders/all">
          <OctagonX size={14} /> Cancel all orders{open ? ` (${open})` : ""}
        </Button>
      </div>

      {confirm === "symbol" && symbol && (
        <ConfirmCancel
          title={`Cancel all ${symbol} orders?`}
          body={`Sends a cancel for each of your ${openInSymbol} open ${symbol} order${openInSymbol === 1 ? "" : "s"}, a few at a time. Orders in other books are left alone, and an order can still fill while its cancel is in flight.`}
          confirmLabel={`Cancel ${base} orders`}
          pending={cancelAll.isPending}
          onClose={() => setConfirm(undefined)}
          onConfirm={() => cancelAll.mutate(symbol, { onSettled: () => setConfirm(undefined) })}
        />
      )}
      {confirm === "all" && (
        <ConfirmCancel
          title="Cancel every open order?"
          body={`Sends one cancel-all to the exchange for all ${open} of your open orders, in every symbol. Cancels are processed one by one, and an order can still fill while its cancel is in flight. If a strategy is still running it may place new orders afterwards — stop it first.`}
          confirmLabel="Cancel everything"
          pending={cancelAll.isPending}
          onClose={() => setConfirm(undefined)}
          onConfirm={() => cancelAll.mutate(undefined, { onSettled: () => setConfirm(undefined) })}
        />
      )}
    </header>
  );
}

function ConnectionDot() {
  const conn = useConn();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, []);
  const quiet = conn.lastMessageAt ? Math.round((Date.now() - conn.lastMessageAt) / 1000) : undefined;
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
