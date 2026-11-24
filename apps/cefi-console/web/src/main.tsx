import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, BookOpen, LayoutGrid, ListOrdered, NotebookPen, TriangleAlert, Wallet, X } from "lucide-react";
import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { isListed, useFillEnrichment, useFillHistory, useInstruments, useSession } from "./api.ts";
import { Balances } from "./components/Balances.tsx";
import { Header } from "./components/Header.tsx";
import { Workspace } from "./components/Layout.tsx";
import { Markets, MarketsList } from "./components/Markets.tsx";
import { OrderBook } from "./components/OrderBook.tsx";
import { OrdersTable } from "./components/OrdersTable.tsx";
import { DrawerProvider, PhoneScreen, usePhone, usePhonePane } from "./components/Phone.tsx";
import { QuoterScreen } from "./components/Quoter.tsx";
import { Ticket } from "./components/Ticket.tsx";
import { Trades } from "./components/Trades.tsx";
import { cx } from "./components/ui.tsx";
import { feed } from "./feed.ts";
import "./styles.css";
import { dismiss, useToasts } from "./toast.ts";
import { UiProvider, useUi } from "./ui-state.tsx";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

function Streams() {
  const qc = useQueryClient();
  const { data: instruments } = useInstruments();
  const { symbol, setSymbol } = useUi();
  // Fills load here, not only in the Fills panel, so the tape can mark yours on any tab.
  useFillHistory();
  useFillEnrichment();

  useEffect(() => {
    // After a reconnect, re-read REST so orders that finished while we were away show their final state.
    feed.onReconnect = () => {
      void qc.invalidateQueries({ queryKey: ["orders"] });
      void qc.invalidateQueries({ queryKey: ["fills"] });
    };
    feed.start();
  }, [qc]);

  // Top of book and trades for every instrument (the tiles, and a tape across all books, since these
  // books trade rarely), but depth only for the symbol on screen: the exchange limits subscription
  // changes, so the topic count stays small.
  const listed = instruments?.filter(isListed);
  const symbols = listed?.map((i) => i.symbol).join(",") ?? "";
  useEffect(() => {
    if (!symbols) return;
    feed.setItems("EBBO", symbols.split(","));
    feed.setItems("TRADE", symbols.split(","));
  }, [symbols]);
  useEffect(() => {
    if (!symbol && listed?.length) setSymbol(listed[0]!.symbol);
  }, [listed, symbol, setSymbol]);
  useEffect(() => {
    feed.setItems("DEPTH", symbol ? [symbol] : []);
  }, [symbol]);

  return null;
}

function Warnings() {
  const { data } = useSession();
  if (!data?.warnings.length) return null;
  return (
    <div className="flex items-start gap-2 border-b border-accent/40 bg-accent-soft px-4 py-2 text-xs text-accent">
      <TriangleAlert size={14} className="mt-0.5 shrink-0" />
      <div>
        {data.warnings.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useToasts();
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            "pointer-events-auto flex items-start gap-2 rounded-md border bg-panel px-3 py-2 text-xs shadow-lg",
            t.kind === "error" ? "border-sell/50 text-sell" : "border-line text-ink",
          )}
        >
          <span className="flex-1 leading-relaxed">{t.text}</span>
          <button type="button" className="text-muted hover:text-ink" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

// The trading screen on a phone: the one-line market bar with the book picker, then one pane at a
// time, picked from the menu.
const TRADING_PANES = ["markets", "book", "ticket", "orders", "fills", "balances"] as const;
type TradingPane = (typeof TRADING_PANES)[number];

function TradingPhone() {
  const { ticket, focusOrderId } = useUi();
  const [pane, setPane] = usePhonePane<TradingPane>("trading", "book", TRADING_PANES);
  // Clicking a price in the book fills the ticket, and clicking a fill finds its order: follow them.
  const seen = useRef({ nonce: ticket.nonce, focusOrderId });
  useEffect(() => {
    if (ticket.nonce !== seen.current.nonce) setPane("ticket");
    else if (focusOrderId && focusOrderId !== seen.current.focusOrderId) setPane("orders");
    seen.current = { nonce: ticket.nonce, focusOrderId };
  }, [ticket.nonce, focusOrderId, setPane]);
  const group = "Trading";
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <Markets phone />
      <div className="min-h-0 flex-1">
        <PhoneScreen<TradingPane>
          pane={pane}
          onPane={setPane}
          panes={[
            { key: "markets", label: "Markets", icon: LayoutGrid, group, node: <MarketsList onPick={() => setPane("book")} /> },
            { key: "book", label: "Order book", icon: BookOpen, group, node: <OrderBook /> },
            { key: "ticket", label: "Ticket", icon: NotebookPen, group, node: <Ticket /> },
            { key: "orders", label: "Orders", icon: ListOrdered, group, node: <OrdersTable /> },
            { key: "fills", label: "Fills and tape", icon: ArrowLeftRight, group, node: <Trades /> },
            { key: "balances", label: "Balances", icon: Wallet, group, node: <Balances /> },
          ]}
        />
      </div>
    </main>
  );
}

function App() {
  const { view } = useUi();
  const { data: session } = useSession();
  const phone = usePhone();
  const quoter = view === "quoter" && !!session?.quoter;
  return (
    <div className="flex h-full flex-col">
      <Streams />
      <Header />
      <Warnings />
      {quoter ? (
        <main className="min-h-0 flex-1 overflow-hidden p-2">
          <QuoterScreen />
        </main>
      ) : phone ? (
        <TradingPhone />
      ) : (
        <main className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <Markets />
          <div className="min-h-0 flex-1">
            <Workspace orders={<OrdersTable />} fills={<Trades />} balances={<Balances />} book={<OrderBook />} ticket={<Ticket />} />
          </div>
        </main>
      )}
      <Toasts />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <UiProvider>
        <DrawerProvider>
          <App />
        </DrawerProvider>
      </UiProvider>
    </QueryClientProvider>
  </StrictMode>,
);
