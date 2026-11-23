import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert, X } from "lucide-react";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { isListed, useFillEnrichment, useFillHistory, useInstruments, useSession } from "./api.ts";
import { Balances } from "./components/Balances.tsx";
import { Header } from "./components/Header.tsx";
import { Workspace } from "./components/Layout.tsx";
import { Markets } from "./components/Markets.tsx";
import { OrderBook } from "./components/OrderBook.tsx";
import { OrdersTable } from "./components/OrdersTable.tsx";
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

function App() {
  const { view } = useUi();
  const { data: session } = useSession();
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
        <App />
      </UiProvider>
    </QueryClientProvider>
  </StrictMode>,
);
