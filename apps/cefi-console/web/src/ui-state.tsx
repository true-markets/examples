import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Side } from "../../shared/wire.ts";

export interface TicketPrefill {
  price?: string;
  side?: Side;
  // Bumped on every prefill so the ticket applies it even when the values repeat.
  nonce: number;
}

export type View = "trading" | "quoter";

interface UiState {
  view: View;
  setView: (v: View) => void;
  symbol: string | undefined;
  setSymbol: (s: string) => void;
  ticket: TicketPrefill;
  prefillTicket: (p: Omit<TicketPrefill, "nonce">) => void;
  focusOrderId: string | undefined;
  setFocusOrderId: (id: string | undefined) => void;
}

const Ctx = createContext<UiState | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>(() => (location.hash === "#quoter" ? "quoter" : "trading"));
  const [symbol, setSymbol] = useState<string>();
  const [ticket, setTicket] = useState<TicketPrefill>({ nonce: 0 });
  const [focusOrderId, setFocusOrderId] = useState<string>();
  const value = useMemo<UiState>(
    () => ({
      view,
      setView: (v: View) => {
        setView(v);
        // The hash keeps the screen across a reload.
        history.replaceState(null, "", v === "quoter" ? "#quoter" : location.pathname + location.search);
      },
      symbol,
      setSymbol,
      ticket,
      prefillTicket: (p) => setTicket((t) => ({ ...p, nonce: t.nonce + 1 })),
      focusOrderId,
      setFocusOrderId,
    }),
    [view, symbol, ticket, focusOrderId],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUi(): UiState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useUi outside UiProvider");
  return v;
}
