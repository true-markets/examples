import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../api.ts";
import { Footer } from "../components/AppShell.tsx";
import { Logo, pillClass } from "../components/ui.tsx";
import type { Me } from "../types.ts";

const DEMO_LOGIN = { email: "hana.sato@kumi.example", password: "kumi-demo" };

const INPUT = "box-border h-12 rounded-xl border border-control bg-white px-3.5 text-base text-ink";

export function SignIn() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signIn = useMutation({
    mutationFn: (body: { email: string; password: string }) => api<Me>("/api/login", { method: "POST", body }),
    onSuccess: (me) => {
      queryClient.setQueryData(["me"], me);
      navigate("/", { replace: true });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    signIn.mutate({ email: String(form.get("email")), password: String(form.get("password")) });
  }

  return (
    <div className="flex min-h-screen flex-col">
      <main className="box-border flex flex-1 items-center justify-center px-4 py-12">
        <form onSubmit={onSubmit} className="m-0 flex w-full max-w-[380px] flex-col gap-7">
          <div className="flex flex-col items-center gap-5">
            <span className="flex items-center gap-2.5">
              <Logo size={32} />
              <span className="text-[22px] font-semibold tracking-[-0.02em]">Kumi</span>
            </span>
            <h1 className="m-0 text-[26px] font-semibold tracking-[-0.03em]">Sign in to Kumi</h1>
          </div>
          <div className="flex flex-col gap-[18px]">
            <label className="flex flex-col gap-2 text-sm font-medium text-label">
              Email
              <input name="email" type="email" autoComplete="username" required defaultValue={DEMO_LOGIN.email} className={INPUT} />
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium text-label">
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                defaultValue={DEMO_LOGIN.password}
                className={INPUT}
              />
            </label>
            {signIn.error && (
              <p role="alert" className="m-0 text-sm text-error">
                {signIn.error.message}
              </p>
            )}
          </div>
          <button type="submit" disabled={signIn.isPending} className={pillClass("primary", "h-12 rounded-3xl text-base")}>
            {signIn.isPending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </main>
      <Footer className="px-8 pb-8 text-center" />
    </div>
  );
}
