import { Check, Clock } from "lucide-react";
import { shortAddress } from "../../format.ts";
import { Button } from "../ui.tsx";

export interface WithdrawalResult {
  status: "confirmed" | "failed" | "unconfirmed";
  signature: string;
  tx_url: string;
}

// The last step: what happened, with the link to check it.
export function WithdrawResult({ result, symbol, amount, to, onDone }: { result: WithdrawalResult; symbol: string; amount: string; to: string; onDone: () => void }) {
  const done = result.status === "confirmed";
  return (
    <div role="status" className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <span aria-hidden className={`flex size-9 items-center justify-center rounded-full text-white ${done ? "bg-ink" : "bg-muted"}`}>
          {done ? <Check className="size-5" strokeWidth={2.4} /> : <Clock className="size-5" />}
        </span>
        <div className="flex flex-col">
          <span className="text-lg font-semibold tracking-[-0.01em]">
            {done ? `Sent ${amount} ${symbol}` : "Submitted, not confirmed yet"}
          </span>
          <span className="text-base text-muted">to {shortAddress(to)}</span>
        </div>
      </div>
      {!done && (
        <p className="m-0 text-base text-label">
          The network has not confirmed it yet. Check the transaction before sending again, because it may still land.
        </p>
      )}
      <a href={result.tx_url} target="_blank" rel="noreferrer" className="w-fit text-base text-motion no-underline hover:underline">
        View on Solscan ↗
      </a>
      <Button className="h-12 rounded-3xl text-base" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
