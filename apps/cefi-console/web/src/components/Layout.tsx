import type { ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { cx } from "./ui.tsx";

// Resizable panes. Drag a divider to resize, double-click it to reset; each split remembers its
// sizes in localStorage. Sizes as strings are percentages, numbers are pixels.

export function Split({ id, orientation, children }: { id: string; orientation: "horizontal" | "vertical"; children: ReactNode }) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: `cefi-console:${id}`, storage: safeStorage() });
  return (
    <Group id={id} orientation={orientation} defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged} className="h-full w-full">
      {children}
    </Group>
  );
}

export function Divider({ vertical }: { vertical?: boolean }) {
  return (
    <Separator
      className={cx(
        "group/sep relative flex items-center justify-center outline-none",
        vertical ? "h-2 w-full cursor-row-resize" : "h-full w-2 cursor-col-resize",
      )}
    >
      <div
        className={cx(
          "rounded-full bg-line transition-colors group-data-[separator=active]/sep:bg-info group-data-[separator=hover]/sep:bg-faint",
          vertical ? "h-0.5 w-10" : "h-10 w-0.5",
        )}
      />
    </Separator>
  );
}

export const pane = "h-full min-h-0 min-w-0";

export function Workspace({ orders, fills, balances, book, ticket }: Record<"orders" | "fills" | "balances" | "book" | "ticket", ReactNode>) {
  return (
    <Split id="main" orientation="horizontal">
      <Panel id="left" defaultSize="72" minSize="40">
        <Split id="left" orientation="vertical">
          <Panel id="orders" defaultSize="62" minSize={160}>
            <div className={pane}><ErrorBoundary name="Orders">{orders}</ErrorBoundary></div>
          </Panel>
          <Divider vertical />
          <Panel id="bottom" defaultSize="38" minSize={120}>
            <Split id="bottom" orientation="horizontal">
              <Panel id="fills" defaultSize="50" minSize={240}>
                <div className={pane}><ErrorBoundary name="Fills and tape">{fills}</ErrorBoundary></div>
              </Panel>
              <Divider />
              <Panel id="balances" defaultSize="50" minSize={240}>
                <div className={pane}><ErrorBoundary name="Balances">{balances}</ErrorBoundary></div>
              </Panel>
            </Split>
          </Panel>
        </Split>
      </Panel>
      <Divider />
      <Panel id="right" defaultSize="28" minSize={280}>
        <Split id="right" orientation="vertical">
          <Panel id="book" defaultSize="64" minSize={160}>
            <div className={pane}><ErrorBoundary name="Order book">{book}</ErrorBoundary></div>
          </Panel>
          <Divider vertical />
          <Panel id="ticket" defaultSize="36" minSize={120}>
            <div className={pane}><ErrorBoundary name="Ticket">{ticket}</ErrorBoundary></div>
          </Panel>
        </Split>
      </Panel>
    </Split>
  );
}

// localStorage can be missing or throw (private windows, blocked storage); layouts then just don't persist.
function safeStorage() {
  return {
    getItem: (k: string) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k: string, v: string) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        // not persisted
      }
    },
  };
}
