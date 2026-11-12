import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { api, useAssets } from "../api.ts";
import { usd } from "../format.ts";
import { assetBySymbol, positions } from "../positions.ts";
import type { HouseholdSummary, Side } from "../types.ts";
import { ComposeStep } from "./trade/ComposeStep.tsx";
import { ReviewStep } from "./trade/ReviewStep.tsx";
import { useTradeDraft } from "./trade/useTradeDraft.ts";
import { SidePanel } from "./ui.tsx";

// The side panel for placing a trade: compose it, review it, then hand it to the server.
export function TradePanel({ household, onClose }: { household: HouseholdSummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const assets = useAssets();
  const [side, setSide] = useState<Side>("buy");
  const [symbol, setSymbol] = useState("SOL");
  const [amounts, setAmounts] = useState<Record<Side, string>>({ buy: "", sell: "" });
  const [reviewing, setReviewing] = useState(false);

  const amount = amounts[side];
  const draft = useTradeDraft(household, assets.data, side, symbol, amount);
  const rows = useMemo(() => positions(household.safekeeping, household.trading, assets.data ?? []), [household, assets.data]);
  const position = rows.find((r) => r.symbol === symbol);

  const place = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/api/households/${encodeURIComponent(household.id)}/trades`, {
        method: "POST",
        body: side === "buy" ? { side, asset: symbol, usd: amount } : { side, asset: symbol, qty: amount },
      }),
    onSuccess: ({ id }) => {
      void queryClient.invalidateQueries({ queryKey: ["households"] });
      void queryClient.invalidateQueries({ queryKey: ["household", household.id] });
      navigate(`/trades/${id}`);
    },
  });

  function pickSide(next: Side) {
    setSide(next);
    setReviewing(false);
    place.reset();
  }

  return (
    <SidePanel titleId="trade-title" title="New trade" subtitle={household.name} onClose={onClose}>

      {reviewing ? (
        <ReviewStep
          draft={draft}
          clientName={household.name}
          side={side}
          symbol={symbol}
          amount={amount}
          iconOf={(sym) => assetBySymbol(assets.data, sym)?.icon ?? null}
          pricesUpdatedAt={assets.dataUpdatedAt}
          error={place.error}
          placing={place.isPending}
          onBack={() => setReviewing(false)}
          onConfirm={() => place.mutate()}
        />
      ) : (
        <ComposeStep
          draft={draft}
          side={side}
          symbol={symbol}
          amount={amount}
          pricesUpdatedAt={assets.dataUpdatedAt}
          position={{
            quantity: position?.quantity ?? "0",
            value: position?.value != null ? usd(position.value) : null,
          }}
          onSide={pickSide}
          onSymbol={(next) => {
            setSymbol(next);
            setAmounts({ buy: amounts.buy, sell: "" });
          }}
          onAmount={(next) => setAmounts({ ...amounts, [side]: next })}
          onReview={() => setReviewing(true)}
        />
      )}
    </SidePanel>
  );
}
