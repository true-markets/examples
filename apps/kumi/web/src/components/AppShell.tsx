import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, Outlet, useNavigate } from "react-router";
import { api, ApiError, isUnreachable, useMe, useAssets } from "../api.ts";
import type { Me } from "../types.ts";
import { Loading, Logo } from "./ui.tsx";

export function Footer({ className = "" }: { className?: string }) {
  return <p className={`m-0 text-[13px] text-muted ${className}`}>Example app. Names and amounts are made up.</p>;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

function AdvisorMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  async function signOut() {
    // A session the server no longer recognises is signed out all the same.
    await api("/api/logout", { method: "POST" }).catch(() => undefined);
    queryClient.clear();
    navigate("/login", { replace: true });
  }

  return (
    <div ref={menu} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-11 cursor-pointer items-center gap-2.5 border-0 bg-transparent pr-1 pl-2 text-sm text-ink"
      >
        {me.name}
        <span aria-hidden className="flex size-[30px] items-center justify-center rounded-full bg-ink text-[11px] font-medium text-white">
          {initials(me.name)}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-12 right-0 z-10 flex min-w-[220px] flex-col rounded-xl border border-hairline bg-white p-1.5 shadow-[0_12px_32px_rgba(12,15,20,.12)]"
        >
          <span className="px-3 py-2 text-[13px] text-muted">{me.email}</span>
          <button
            type="button"
            role="menuitem"
            onClick={() => void signOut()}
            className="h-11 cursor-pointer rounded-lg border-0 bg-transparent px-3 text-left text-sm font-medium text-ink hover:bg-paper"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function Unreachable() {
  return (
    <div role="alert" className="border-b border-hairline bg-white">
      <p className="mx-auto m-0 max-w-[1200px] px-8 py-3 text-sm text-error">
        Kumi's server is not reachable. Balances and trades may be out of date until it is back.
      </p>
    </div>
  );
}

export function AppShell() {
  const me = useMe();
  const assets = useAssets();

  if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" replace />;

  return (
    <div className="flex min-h-screen flex-col">
      {(me.error || isUnreachable(assets.error)) && <Unreachable />}
      <header className="border-b border-hairline">
        <div className="mx-auto flex min-h-16 max-w-[1200px] flex-wrap items-center gap-x-5 gap-y-3 px-8">
          <Link to="/" aria-label="Kumi, clients" className="flex min-h-11 items-center gap-[9px] text-ink no-underline">
            <Logo />
            <span className="text-[17px] font-semibold tracking-[-0.02em]">Kumi</span>
          </Link>
          <span className="flex-1" />
          {me.data && <AdvisorMenu me={me.data} />}
        </div>
      </header>
      <main className="mx-auto box-border flex w-full max-w-[1200px] flex-1 flex-col gap-10 px-8 pt-10 pb-8">
        {me.isPending ? <Loading /> : me.data ? <Outlet /> : null}
        <Footer className="mt-auto pt-4" />
      </main>
    </div>
  );
}
