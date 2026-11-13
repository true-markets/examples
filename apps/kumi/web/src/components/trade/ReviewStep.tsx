import { ArrowDown } from "lucide-react";
import { tokenAmount, unitPrice, usd } from "../../format.ts";
import type { Side } from "../../types.ts";
import { AssetLogo, Button } from "../ui.tsx";
import { AllocationBars } from "./allocation.tsx";
import { UpdatedAgo } from "./parts.tsx";
import type { TradeDraft } from "./useTradeDraft.ts";

interface Props {
  draft: TradeDraft;
  clientName: string;
  side: Side;
  symbol: string;
  amount: string;
  iconOf: (symbol: string) => string | null;
  pricesUpdatedAt: number;
  error: Error | null;
  placing: boolean;
  onBack: () => void;
  onConfirm: () => void;
}

function AssetAmount({ label, amount, symbol, icon, truncate = false }: { label: string; amount: string; symbol: string; icon: string | null; truncate?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-sm text-muted">{label}</span>
        <span className={`text-[28px] leading-none font-medium tracking-[-0.03em] ${truncate ? "truncate" : ""}`}>{amount}</span>
      </span>
      <span className="flex items-center gap-2 text-[15px] font-medium">
        <AssetLogo symbol={symbol} icon={icon} size={28} />
        {symbol}
      </span>
    </div>
  );
}

// The second step: the order as it will be placed, what it costs and what happens next.
export function ReviewStep({ draft, clientName, side, symbol, amount, iconOf, pricesUpdatedAt, error, placing, onBack, onConfirm }: Props) {
  const { asset, youGet, change } = draft;
  const buy = side === "buy";
  const paySymbol = buy ? "USDC" : symbol;
  const getSymbol = buy ? symbol : "USDC";
  const payAmount = buy ? usd(amount || "0") : tokenAmount(amount || "0", symbol).replace(` ${symbol}`, "");
  const getAmount = youGet.replace("About ", "≈ ").replace(` ${getSymbol}`, "");
  const moved = tokenAmount(amount || "0", paySymbol);
  const steps = [
    `Move ${moved} to the trading wallet`,
    `${buy ? "Buy" : "Sell"} ${symbol} at market`,
    `Return the ${getSymbol} to the client wallet`,
  ];

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-1.5">
        <h3 className="m-0 text-xl font-semibold tracking-[-0.02em]">Review {buy ? "buy" : "sell"} order</h3>
        <span className="text-base text-muted">Market order for {clientName}</span>
      </div>

      <div className="flex flex-col rounded-2xl border border-hairline bg-paper">
        <AssetAmount label="You pay" amount={payAmount} symbol={paySymbol} icon={iconOf(paySymbol)} />
        <div className="relative border-t border-hairline">
          <span className="absolute -top-3.5 left-5 flex size-7 items-center justify-center rounded-full border border-hairline bg-white">
            <ArrowDown aria-hidden className="size-4 text-label" />
          </span>
        </div>
        <div className="pt-2">
          <AssetAmount label="You get, estimated" amount={getAmount} symbol={getSymbol} icon={iconOf(getSymbol)} truncate />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <dl className="m-0 flex flex-col divide-y divide-hairline rounded-2xl border border-hairline bg-white text-base">
          <div className="flex items-baseline justify-between gap-4 px-5 py-4">
            <dt className="text-sm text-muted">Price</dt>
            <dd className="m-0 flex flex-col items-end">
              <span className="font-medium">
                {unitPrice(asset.price)} <span className="font-normal text-muted">per {symbol}</span>
              </span>
              <span className="text-sm text-muted">
                <UpdatedAgo updatedAt={pricesUpdatedAt} />
              </span>
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 px-5 py-4">
            <dt className="text-sm text-muted">Fees</dt>
            <dd className="m-0 flex flex-col items-end">
              <span className="font-medium">
                About 0.2% <span className="font-normal text-muted">plus network fees</span>
              </span>
              <span className="text-sm text-muted">Exact amounts shown after the trade</span>
            </dd>
          </div>
          {change && (
            <div className="flex flex-col gap-3 px-5 py-4">
              <dt className="text-sm text-muted">Allocation</dt>
              <dd className="m-0">
                <AllocationBars change={change} />
              </dd>
            </div>
          )}
        </dl>
        <p className="m-0 px-1 text-sm text-muted">Market order. The final price can differ slightly.</p>
      </div>

      <div className="flex flex-col gap-4">
        <h4 className="m-0 text-sm font-medium text-muted">What happens next</h4>
        <ol className="m-0 flex list-none flex-col p-0">
          {steps.map((step, i) => (
            <li key={step} className="flex gap-3.5">
              <span className="flex flex-col items-center">
                <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full border border-hairline bg-white text-sm font-medium text-label">
                  {i + 1}
                </span>
                {i < steps.length - 1 && <span aria-hidden className="my-1 w-px flex-1 bg-hairline" />}
              </span>
              <span className={`pt-[3px] text-base leading-snug text-ink ${i < steps.length - 1 ? "pb-5" : ""}`}>{step}</span>
            </li>
          ))}
        </ol>
      </div>

      {error && (
        <p role="alert" className="m-0 text-sm text-error">
          {error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" className="h-12 flex-1 rounded-3xl text-base" onClick={onBack}>
          Back
        </Button>
        <Button className="h-12 flex-[2] rounded-3xl text-base" disabled={placing} onClick={onConfirm}>
          {placing ? "Placing…" : buy ? `Buy ${symbol}` : `Sell ${symbol}`}
        </Button>
      </div>
    </div>
  );
}
