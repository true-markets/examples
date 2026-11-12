import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Clock, X } from "lucide-react";
import { useMemo, useState } from "react";
import { maxWithdrawable } from "../../../shared/withdraw-rules.ts";
import { api, useAssets } from "../api.ts";
import { shortAddress, tokenAmount } from "../format.ts";
import { assetBySymbol } from "../positions.ts";
import type { HouseholdDetail } from "../types.ts";
import { AddressField, addressProblem } from "./withdraw/AddressField.tsx";
import { AssetLogo, Button, Mono, pillClass, SidePanel } from "./ui.tsx";

interface TransferResult {
  symbol: string;
  amount: string;
  status: "confirmed" | "unconfirmed" | "failed";
  tx_url?: string;
  message?: string;
}

interface TransferAllResponse {
  results: TransferResult[];
  stopped: boolean;
  left: string[];
}

type Step = "form" | "review" | "result";

// What a full transfer moves: USDC, each token, then the SOL that is left after fees.
function useMovingAssets(household: HouseholdDetail) {
  const assets = useAssets();
  return useMemo(() => {
    const { safekeeping } = household;
    const rows = [
      { symbol: "USDC", amount: safekeeping.usdc },
      ...Object.entries(safekeeping.tokens).map(([symbol, amount]) => ({ symbol, amount })),
      { symbol: "SOL", amount: maxWithdrawable("SOL", safekeeping.sol) },
    ].filter((r) => Number(r.amount) > 0);
    return rows.map((r) => ({ ...r, icon: assetBySymbol(assets.data, r.symbol)?.icon ?? null }));
  }, [household, assets.data]);
}

function MovingList({ rows }: { rows: { symbol: string; amount: string; icon: string | null }[] }) {
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-hairline rounded-2xl border border-hairline bg-white p-0">
      {rows.map((r) => (
        <li key={r.symbol} className="flex items-center justify-between gap-4 px-5 py-3.5 text-base">
          <span className="flex items-center gap-3 font-medium">
            <AssetLogo symbol={r.symbol} icon={r.icon} size={28} />
            {r.symbol}
          </span>
          <span>
            {tokenAmount(r.amount, r.symbol)}
            {r.symbol === "SOL" && <span className="block text-right text-sm text-muted">after network fees</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Results({ response, to, onDone }: { response: TransferAllResponse; to: string; onDone: () => void }) {
  const allDone = !response.stopped && response.results.every((r) => r.status === "confirmed");
  return (
    <div role="status" className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <span className="text-lg font-semibold tracking-[-0.01em]">
          {allDone ? `Transferred ${response.results.length} ${response.results.length === 1 ? "asset" : "assets"}` : "Transfer stopped"}
        </span>
        <span className="text-base text-muted">to {shortAddress(to)}</span>
      </div>
      <ul className="m-0 flex list-none flex-col divide-y divide-hairline rounded-2xl border border-hairline bg-white p-0">
        {response.results.map((r) => (
          <li key={r.symbol} className="flex items-start gap-3 px-5 py-3.5 text-base">
            <span aria-hidden className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-white ${r.status === "confirmed" ? "bg-ink" : r.status === "failed" ? "bg-error" : "bg-muted"}`}>
              {r.status === "confirmed" ? <Check className="size-4" strokeWidth={2.4} /> : r.status === "failed" ? <X className="size-4" /> : <Clock className="size-4" />}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">{tokenAmount(r.amount, r.symbol)}</span>
              <span className="text-sm text-muted">
                {r.status === "confirmed" ? "Confirmed" : r.status === "unconfirmed" ? "Submitted, not confirmed yet" : (r.message ?? "Failed")}
              </span>
            </span>
            {r.tx_url && (
              <a href={r.tx_url} target="_blank" rel="noreferrer" className="text-sm text-motion no-underline hover:underline">
                Solscan ↗
              </a>
            )}
          </li>
        ))}
      </ul>
      {response.stopped && (
        <p className="m-0 rounded-xl bg-segment px-4 py-3 text-sm text-label">
          It stopped here. Everything not listed as confirmed is still in the client wallet. Check the last transaction before trying again.
        </p>
      )}
      {response.left.length > 0 && (
        <p className="m-0 text-sm text-muted">A little {response.left.join(", ")} is left in the client wallet. It is too small to send.</p>
      )}
      <Button className="h-12 rounded-3xl text-base" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

// The side panel for moving everything a client wallet holds to one Solana address, without selling anything.
export function TransferAllPanel({ household, onClose }: { household: HouseholdDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const rows = useMovingAssets(household);
  const [step, setStep] = useState<Step>("form");
  const [to, setTo] = useState("");

  const transfer = useMutation({
    mutationFn: () => api<TransferAllResponse>(`/api/households/${encodeURIComponent(household.id)}/transfer-all`, { method: "POST", body: { to } }),
    onSettled: () => {
      setStep("result");
      void queryClient.invalidateQueries({ queryKey: ["households"] });
      void queryClient.invalidateQueries({ queryKey: ["household", household.id] });
    },
  });

  const ready = to !== "" && addressProblem(to, household.safekeeping_address) === null && rows.length > 0;

  return (
    <SidePanel titleId="transfer-title" title="Transfer all assets" subtitle={household.name} onClose={onClose} busy={transfer.isPending}>

      {step === "form" && (
        <form
          className="m-0 flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) setStep("review");
          }}
        >
          <p className="m-0 text-base text-label">Moves everything the client wallet holds to one address. Nothing is sold.</p>
          <AddressField value={to} ownAddress={household.safekeeping_address} onChange={setTo} />
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-label">What moves</span>
            {rows.length > 0 ? <MovingList rows={rows} /> : <p className="m-0 text-base text-muted">The client wallet holds nothing to transfer.</p>}
          </div>
          <button type="submit" disabled={!ready} className={pillClass("primary", "h-12 rounded-3xl text-base")}>
            Review transfer
          </button>
        </form>
      )}

      {step === "review" && (
        <div className="flex flex-col gap-7">
          <div className="flex flex-col gap-1.5">
            <h3 className="m-0 text-xl font-semibold tracking-[-0.02em]">Review transfer</h3>
            <span className="text-base text-muted">From {household.name}'s client wallet</span>
          </div>
          <MovingList rows={rows} />
          <div className="flex flex-col gap-1.5 rounded-2xl border border-hairline bg-white px-5 py-4">
            <span className="text-sm text-muted">To</span>
            <Mono className="text-sm break-all">{to}</Mono>
          </div>
          <p className="m-0 rounded-xl bg-segment px-4 py-3 text-sm text-label">
            Check the address. A transfer is final and can't be undone. Each asset is sent and confirmed in turn, which can take a minute or more.
          </p>
          {transfer.isPending && <p className="m-0 text-sm text-muted">Transferring… keep this open until it finishes.</p>}
          <div className="flex gap-2">
            <Button variant="secondary" className="h-12 flex-1 rounded-3xl text-base" disabled={transfer.isPending} onClick={() => setStep("form")}>
              Back
            </Button>
            <Button className="h-12 flex-[2] rounded-3xl text-base" disabled={transfer.isPending} onClick={() => transfer.mutate()}>
              {transfer.isPending ? "Transferring…" : "Transfer all"}
            </Button>
          </div>
        </div>
      )}

      {step === "result" && transfer.data && <Results response={transfer.data} to={to} onDone={onClose} />}
      {step === "result" && transfer.error && (
        <div role="alert" className="flex flex-col gap-4">
          <p className="m-0 text-base text-error">{transfer.error.message}</p>
          <Button variant="secondary" className="h-12 rounded-3xl text-base" onClick={() => setStep("form")}>
            Back
          </Button>
        </div>
      )}
    </SidePanel>
  );
}
