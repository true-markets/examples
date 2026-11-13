import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { api } from "../api.ts";
import { isEmpty } from "../positions.ts";
import type { HouseholdDetail } from "../types.ts";
import { TransferAllPanel } from "./TransferAllPanel.tsx";
import { WithdrawPanel } from "./WithdrawPanel.tsx";
import { Button, CopyButton, Mono } from "./ui.tsx";

interface ReturnResult {
  symbol: string;
  ok: boolean;
  received?: string;
  message?: string;
}

// Addresses and status for a client's two wallets, and the ways funds leave them. Collapsed, so the main page stays quiet.
export function Wallets({ household, tradeActive }: { household: HouseholdDetail; tradeActive: boolean }) {
  const queryClient = useQueryClient();
  const [withdrawing, setWithdrawing] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const t = household.trading;
  const inUse = t !== null && !isEmpty(t);

  const returnFunds = useMutation({
    mutationFn: () => api<{ results: ReturnResult[] }>(`/api/households/${encodeURIComponent(household.id)}/return-funds`, { method: "POST" }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["household", household.id] });
      void queryClient.invalidateQueries({ queryKey: ["households"] });
    },
  });

  return (
    <details className="group rounded-2xl border border-hairline bg-white">
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-2 px-5 text-base font-medium">
        <ChevronRight aria-hidden className="size-4 text-muted transition-transform group-open:rotate-90" />
        Wallets
        <span className="font-normal text-muted">· Addresses and status</span>
      </summary>
      <dl className="m-0 flex flex-col border-t border-hairline">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="text-sm font-medium">Client wallet</dt>
            <dd className="m-0 text-sm text-muted">Holds this client's assets.</dd>
            <dd className="m-0">
              <Mono className="text-sm break-all">{household.safekeeping_address}</Mono>
            </dd>
          </div>
          <div className="flex flex-wrap gap-2">
            <CopyButton value={household.safekeeping_address} />
            <Button variant="secondary" className="h-9 px-3.5 text-sm" disabled={tradeActive || isEmpty(household.safekeeping)} onClick={() => setWithdrawing(true)}>
              Withdraw
            </Button>
            <Button variant="secondary" className="h-9 px-3.5 text-sm" disabled={tradeActive || isEmpty(household.safekeeping)} onClick={() => setTransferring(true)}>
              Transfer all
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="flex items-center gap-2 text-sm font-medium">
              Trading wallet
              <span className={`rounded-full px-2 py-0.5 text-sm font-medium ${inUse ? "bg-motion/10 text-motion" : "bg-segment text-label"}`}>
                {inUse ? "In use" : "Idle"}
              </span>
            </dt>
            <dd className="m-0 text-sm text-muted">Executes each order. Empty between trades.</dd>
            <dd className="m-0">
              <Mono className="text-sm break-all">{household.trading_address ?? "Not created yet"}</Mono>
            </dd>
            {returnFunds.isPending && <dd className="m-0 text-sm text-muted">Returning funds to the client wallet…</dd>}
            {returnFunds.error && <dd className="m-0 text-sm text-error">{returnFunds.error.message}</dd>}
            {returnFunds.data?.results.map((r) => (
              <dd key={r.symbol} className={`m-0 text-sm ${r.ok ? "text-label" : "text-error"}`}>
                {r.ok ? `${r.symbol} returned to the client wallet.` : `${r.symbol}: ${r.message}`}
              </dd>
            ))}
            {returnFunds.data?.results.length === 0 && <dd className="m-0 text-sm text-label">Nothing to return.</dd>}
          </div>
          <div className="flex flex-wrap gap-2">
            {household.trading_address && <CopyButton value={household.trading_address} />}
            {inUse && (
              <Button variant="secondary" className="h-9 px-3.5 text-sm" disabled={tradeActive || returnFunds.isPending} onClick={() => returnFunds.mutate()}>
                Return funds
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="text-sm font-medium">Client ID</dt>
            <dd className="m-0">
              <Mono className="text-sm break-all">{household.id}</Mono>
            </dd>
          </div>
          <CopyButton value={household.id} label="Copy ID" />
        </div>
      </dl>
      {withdrawing && <WithdrawPanel household={household} onClose={() => setWithdrawing(false)} />}
      {transferring && <TransferAllPanel household={household} onClose={() => setTransferring(false)} />}
    </details>
  );
}
