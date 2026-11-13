import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, useAssets } from "../api.ts";
import { assetBySymbol } from "../positions.ts";
import type { HouseholdDetail } from "../types.ts";
import { WithdrawForm } from "./withdraw/WithdrawForm.tsx";
import { WithdrawReview } from "./withdraw/WithdrawReview.tsx";
import { WithdrawResult, type WithdrawalResult } from "./withdraw/WithdrawResult.tsx";
import { SidePanel } from "./ui.tsx";

type Step = "form" | "review" | "result";

// The side panel for sending funds from a client wallet to any Solana address.
export function WithdrawPanel({ household, onClose }: { household: HouseholdDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const assets = useAssets();
  const [step, setStep] = useState<Step>("form");
  const [symbol, setSymbol] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");

  const held = useMemo<Record<string, string>>(
    () => ({ SOL: household.safekeeping.sol, USDC: household.safekeeping.usdc, ...household.safekeeping.tokens }),
    [household.safekeeping],
  );
  const withdrawable = useMemo(() => (assets.data ?? []).filter((a) => Number(held[a.symbol] ?? 0) > 0), [assets.data, held]);

  const send = useMutation({
    mutationFn: () => api<WithdrawalResult>(`/api/households/${encodeURIComponent(household.id)}/withdrawals`, { method: "POST", body: { asset: symbol, amount, to } }),
    onSuccess: () => {
      setStep("result");
      void queryClient.invalidateQueries({ queryKey: ["households"] });
      void queryClient.invalidateQueries({ queryKey: ["household", household.id] });
    },
  });

  // Start on an asset the client actually holds.
  useEffect(() => {
    if (withdrawable.length > 0 && !withdrawable.some((a) => a.symbol === symbol)) setSymbol(withdrawable[0]!.symbol);
  }, [withdrawable, symbol]);

  return (
    <SidePanel titleId="withdraw-title" title="Withdraw funds" subtitle={household.name} onClose={onClose} busy={send.isPending}>

      {withdrawable.length === 0 && step === "form" && <p className="m-0 text-base text-muted">The client wallet holds nothing to withdraw.</p>}

      {withdrawable.length > 0 && step === "form" && (
        <WithdrawForm
          assets={withdrawable}
          held={held}
          symbol={symbol}
          amount={amount}
          to={to}
          ownAddress={household.safekeeping_address}
          solBalance={household.safekeeping.sol}
          onSymbol={(next) => {
            setSymbol(next);
            setAmount("");
          }}
          onAmount={setAmount}
          onTo={setTo}
          onReview={() => setStep("review")}
        />
      )}

      {step === "review" && (
        <WithdrawReview
          symbol={symbol}
          icon={assetBySymbol(assets.data, symbol)?.icon ?? null}
          amount={amount}
          to={to}
          clientName={household.name}
          error={send.error}
          sending={send.isPending}
          onBack={() => {
            send.reset();
            setStep("form");
          }}
          onConfirm={() => send.mutate()}
        />
      )}

      {step === "result" && send.data && <WithdrawResult result={send.data} symbol={symbol} amount={amount} to={to} onDone={onClose} />}
    </SidePanel>
  );
}
