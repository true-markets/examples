import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// A small floating panel anchored under a button. It renders at the end of the page so a table's
// scroll container can't clip it, and closes on Escape or a click outside.
export function Popover({ anchor, onClose, children, width = 260 }: { anchor: HTMLElement; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>();

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
      const height = ref.current?.offsetHeight ?? 0;
      // Open upward when there isn't room below.
      const below = r.bottom + 4;
      const top = below + height > window.innerHeight - 8 && r.top - height - 4 > 8 ? r.top - height - 4 : below;
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, width]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-50 rounded-md border border-line bg-panel p-2.5 text-xs shadow-xl"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
