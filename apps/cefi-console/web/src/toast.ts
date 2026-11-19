import { useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  kind: "ok" | "error";
  text: string;
}

let toasts: Toast[] = [];
let next = 1;
const listeners = new Set<() => void>();

function push(kind: Toast["kind"], text: string): void {
  const t = { id: next++, kind, text };
  toasts = [...toasts.slice(-4), t];
  listeners.forEach((l) => l());
  setTimeout(() => dismiss(t.id), kind === "error" ? 8_000 : 3_500);
}

export function dismiss(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  listeners.forEach((l) => l());
}

export const toast = {
  ok: (text: string) => push("ok", text),
  error: (text: string) => push("error", text),
};

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => toasts,
  );
}
