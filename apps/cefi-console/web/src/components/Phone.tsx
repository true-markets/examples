import type { LucideIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { cx } from "./ui.tsx";

// The phone layout. Below 768px wide each screen shows one pane at a time, full size, and the
// hamburger in the header opens a drawer listing the screen's panes, its settings and the header's
// actions. Wider screens keep the resizable desktop layout.

const PHONE_QUERY = "(max-width: 767px)";

export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

interface Drawer {
  open: boolean;
  setOpen: (open: boolean) => void;
  // Where the screen on show puts its pane list and settings, inside the drawer.
  slot: HTMLElement | null;
  setSlot: (el: HTMLElement | null) => void;
}

const DrawerCtx = createContext<Drawer | null>(null);

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ open, setOpen, slot, setSlot }), [open, slot]);
  return <DrawerCtx.Provider value={value}>{children}</DrawerCtx.Provider>;
}

export function useDrawer(): Drawer {
  const v = useContext(DrawerCtx);
  if (!v) throw new Error("useDrawer outside DrawerProvider");
  return v;
}

// The pane a phone screen shows, kept per browser.
export function usePhonePane<T extends string>(id: string, fallback: T, allowed: readonly T[]): [T, (p: T) => void] {
  const key = `cefi-console:phone-pane-${id}`;
  const [pane, setPaneState] = useState<T>(() => {
    try {
      const got = localStorage.getItem(key) as T | null;
      return got && allowed.includes(got) ? got : fallback;
    } catch {
      return fallback;
    }
  });
  const setPane = useCallback(
    (p: T) => {
      setPaneState(p);
      try {
        localStorage.setItem(key, p);
      } catch {
        // not kept
      }
    },
    [key],
  );
  return [allowed.includes(pane) ? pane : fallback, setPane];
}

export interface PhonePane<T extends string> {
  key: T;
  label: string;
  icon: LucideIcon;
  // Panes with the same group sit under one heading in the drawer.
  group: string;
  // A short figure shown after the label, e.g. a count.
  note?: ReactNode;
  node: ReactNode;
}

// One pane at a time. The pane list, and any settings, go into the drawer.
export function PhoneScreen<T extends string>({
  panes,
  pane,
  onPane,
  settings,
}: {
  panes: PhonePane<T>[];
  pane: T;
  onPane: (p: T) => void;
  settings?: ReactNode;
}) {
  const drawer = useDrawer();
  const shown = panes.find((p) => p.key === pane) ?? panes[0];
  const groups = [...new Set(panes.map((p) => p.group))];
  return (
    <>
      <div className="h-full min-h-0 overflow-hidden">{shown && <ErrorBoundary name={shown.label}>{shown.node}</ErrorBoundary>}</div>
      {drawer.slot &&
        createPortal(
          <>
            {groups.map((g) => (
              <DrawerSection key={g} title={g}>
                {panes
                  .filter((p) => p.group === g)
                  .map((p) => (
                    <DrawerItem
                      key={p.key}
                      icon={p.icon}
                      active={p.key === shown?.key}
                      onClick={() => {
                        onPane(p.key);
                        drawer.setOpen(false);
                      }}
                    >
                      {p.label}
                      {p.note !== undefined && <span className="ml-auto text-[11px] font-normal text-faint">{p.note}</span>}
                    </DrawerItem>
                  ))}
              </DrawerSection>
            ))}
            {settings && <DrawerSection title="Display">{settings}</DrawerSection>}
          </>,
          drawer.slot,
        )}
    </>
  );
}

export function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line px-2 py-2">
      <h3 className="px-2 pb-1 text-[10px] font-semibold tracking-wider text-faint uppercase">{title}</h3>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

export function DrawerItem({
  icon: Icon,
  active,
  danger,
  disabled,
  onClick,
  children,
}: {
  icon: LucideIcon;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cx(
        "flex min-h-10 w-full items-center gap-2.5 rounded px-2 text-left text-sm disabled:opacity-40",
        active ? "bg-raised font-semibold text-ink" : danger ? "text-sell hover:bg-sell-soft" : "text-muted hover:bg-raised hover:text-ink",
      )}
    >
      <Icon size={16} className="shrink-0" />
      {children}
    </button>
  );
}

// A row in the drawer's Display section: a label, and a control on the right.
export function DrawerSetting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-2 px-2 text-sm text-muted">
      {label}
      <span className="ml-auto">{children}</span>
    </div>
  );
}
