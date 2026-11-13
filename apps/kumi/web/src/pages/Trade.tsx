import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useParams } from "react-router";
import { api, useAssets, useTrade } from "../api.ts";
import { assetBySymbol } from "../positions.ts";
import { AssetLogo, Breadcrumb, ButtonLink, DetailRows, ErrorLine, Loading, Mono, SectionLabel, StatusDot } from "../components/ui.tsx";
import { DASH, approxUsd, feesLine, feesUsd, returnedAsset, stamp, statusTone, statusWord, tokenAmount, tradeTitle, unitPrice, usd } from "../format.ts";
import type { HouseholdDetail, Step, StepName, TradeDetail } from "../types.ts";

type Tone = "ink" | "motion" | "muted" | "error";

const TONE_TEXT: Record<Tone, string> = { ink: "text-ink", motion: "text-motion", muted: "text-muted", error: "text-error" };
const DOT: Record<Step["state"], string> = {
  done: "bg-ink",
  running: "bg-motion ring-4 ring-motion/20",
  next: "border-2 border-pending bg-paper",
  failed: "bg-error",
};

interface StepCopy {
  label: string;
  sub: string;
  record: string;
}

function copyFor(trade: TradeDetail, step: Step): StepCopy {
  const buy = trade.side === "buy";
  const inLine = buy ? tokenAmount(trade.usd!, "USDC") : tokenAmount(trade.qty!, trade.asset);
  const outAsset = returnedAsset(trade.side, trade.asset);
  const result = trade.result;
  const outLine = result ? tokenAmount(result.received, outAsset) : outAsset;
  const failed = step.message ?? "Stopped";

  const copy: Record<StepName, Record<Step["state"], [string, string]>> = {
    move_in: {
      done: [`${inLine} from the client wallet`, `${inLine} moved from the client wallet to the trading wallet`],
      running: [`Sending ${inLine}`, `Moving ${inLine} from the client wallet to the trading wallet`],
      next: ["Next", `Move ${inLine} to the trading wallet`],
      failed: ["Stopped", failed],
    },
    trade: {
      done: [
        result ? `${buy ? "Bought" : "Sold"} at ${unitPrice(result.avg_price)} average` : "Done",
        buy
          ? `Bought ${trade.asset}${result ? ` at ${unitPrice(result.avg_price)} average` : " at market"}`
          : `Sold ${inLine}${result ? ` at ${unitPrice(result.avg_price)} average` : " at market"}`,
      ],
      running: [buy ? `Buying ${trade.asset}` : `Selling ${trade.asset}`, buy ? `Buying ${trade.asset} at market` : `Selling ${trade.asset} at market`],
      next: ["Next", buy ? `Buy ${trade.asset} at market` : `Sell ${trade.asset} at market`],
      failed: ["Stopped", failed],
    },
    return: {
      done: [`${outLine} in the client wallet`, `${outLine} moved back to the client wallet`],
      running: [`Sending ${outAsset} back`, `Moving ${outAsset} back to the client wallet`],
      next: ["Next", "Proceeds go back to the client wallet"],
      failed: ["Stopped", failed],
    },
  };
  const labels: Record<StepName, string> = {
    move_in: "Move to trading wallet",
    trade: buy ? "Buy at market" : "Sell at market",
    return: "Back to the client wallet",
  };
  const [sub, record] = copy[step.name][step.state];
  return { label: labels[step.name], sub, record };
}

function recordTone(step: Step): Tone {
  return { done: "ink", running: "motion", next: "muted", failed: "error" }[step.state] as Tone;
}

function recordWhen(step: Step): string {
  if (step.state === "running") return "Now";
  if (step.state === "next") return "Next";
  return step.at ? stamp(step.at) : "";
}

function Timeline({ trade }: { trade: TradeDetail }) {
  return (
    <ol aria-label="Steps" className="m-0 list-none p-0">
      {trade.steps.map((step, i) => {
        const copy = copyFor(trade, step);
        const last = i === trade.steps.length - 1;
        return (
          <li key={step.name} className="flex gap-4">
            <span className="flex flex-col items-center pt-1.5">
              <span aria-hidden className={`size-3 shrink-0 rounded-full ${DOT[step.state]}`} />
              {!last && <span aria-hidden className="mt-1 w-px flex-1 bg-hairline" />}
            </span>
            <div className={`flex min-w-0 flex-1 flex-col gap-1 ${last ? "" : "pb-8"}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span className={`text-base font-medium ${step.state === "next" ? "text-muted" : "text-ink"}`}>{copy.label}</span>
                <span className="text-sm text-muted">{recordWhen(step)}</span>
              </div>
              <span className={`text-base leading-snug ${TONE_TEXT[recordTone(step)]}`}>{copy.record}</span>
              {step.tx_url && (
                <a href={step.tx_url} target="_blank" rel="noreferrer" className="w-fit text-sm text-motion no-underline hover:underline">
                  View on Solscan ↗
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function summaryRows(trade: TradeDetail) {
  const buy = trade.side === "buy";
  const result = trade.result;
  const fees = result ? feesUsd(result.fees, trade.asset, result.avg_price) : null;
  return [
    { k: buy ? "Spent" : "Sold", v: buy ? tokenAmount(trade.usd!, "USDC") : tokenAmount(trade.qty!, trade.asset) },
    { k: "Received", v: result ? tokenAmount(result.received, returnedAsset(trade.side, trade.asset)) : "Pending" },
    { k: "Average price", v: result ? unitPrice(result.avg_price) : "Pending" },
    {
      k: "Fees",
      v: result ? (
        <span className="flex flex-col items-end">
          <span>{result.fees.length === 0 ? "None" : approxUsd(fees)}</span>
          {result.fees.length > 0 && <span className="text-sm text-muted">{feesLine(result.fees)}</span>}
        </span>
      ) : (
        "Pending"
      ),
    },
  ];
}

function SigningDetails({ household }: { household: HouseholdDetail | undefined }) {
  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-base font-medium text-label">
        <ChevronRight aria-hidden className="size-4 text-muted transition-transform group-open:rotate-90" />
        How this trade was signed
      </summary>
      <DetailRows
        rows={[
          { k: "Client wallet transfer", v: "Signed by Kumi" },
          { k: "Trade and move back", v: "Kumi, co-signed by True Markets" },
          { k: "Trading wallet", v: <Mono className="text-sm break-all">{household?.trading_address ?? DASH}</Mono> },
        ]}
      />
    </details>
  );
}

export function Trade() {
  const { id = "" } = useParams();
  const query = useTrade(id);
  const assets = useAssets();
  const householdId = query.data?.household_id;
  const household = useQuery({
    queryKey: ["household", householdId],
    queryFn: () => api<HouseholdDetail>(`/api/households/${encodeURIComponent(householdId!)}`),
    enabled: householdId !== undefined,
  });

  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorLine>{query.error.message}</ErrorLine>;

  const trade = query.data;
  const name = household.data?.name ?? "Client";
  const failed = trade.steps.find((s) => s.state === "failed");
  const title = tradeTitle({ ...trade, received: trade.result?.received });

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-5">
        <Breadcrumb
          items={[{ label: "Clients", to: "/" }, { label: name, to: `/households/${trade.household_id}` }, { label: "Trade" }]}
        />
        <div className="flex flex-col gap-3">
          <span role="status">
            <StatusDot tone={statusTone(trade.status)} className="text-base">
              {statusWord(trade.status)}
            </StatusDot>
          </span>
          <h1 className="m-0 flex items-center gap-4 text-[34px] font-semibold tracking-[-0.035em]">
            <AssetLogo symbol={trade.asset} icon={assetBySymbol(assets.data, trade.asset)?.icon} size={40} />
            {title}
          </h1>
          <span className="text-base text-muted">
            Placed by {trade.placed_by} · {stamp(trade.created_at)}
          </span>
        </div>
      </div>

      {failed && (
        <div role="alert" className="flex flex-col gap-1 border-y border-hairline py-4 text-base">
          <span className="font-medium text-error">{failed.message}</span>
          <span className="text-muted">
            Funds stay where they are. Run <code className="font-mono">npm run return-funds</code> to move them back.
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-start gap-x-14 gap-y-10">
        <section aria-label="Timeline" className="flex min-w-0 flex-[999_1_480px] flex-col gap-4">
          <SectionLabel>Timeline</SectionLabel>
          <Timeline trade={trade} />
        </section>

        <section aria-label="Summary" className="flex min-w-0 flex-[1_1_340px] flex-col gap-4">
          <SectionLabel>Summary</SectionLabel>
          <DetailRows rows={summaryRows(trade)} />
          <SigningDetails household={household.data} />
        </section>
      </div>

      <div className="flex flex-wrap gap-2">
        <ButtonLink variant="secondary" to={`/households/${trade.household_id}`}>
          Back to {name}
        </ButtonLink>
      </div>
    </div>
  );
}
