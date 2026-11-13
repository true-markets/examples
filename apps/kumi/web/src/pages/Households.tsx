import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api, useHouseholds } from "../api.ts";
import { AddHousehold } from "../components/AddHousehold.tsx";
import { Button, Chevron, ErrorLine, Loading, StatusDot, TextButton } from "../components/ui.tsx";
import { lastActivity, statusWord, totalValue, tradeTitle, usd } from "../format.ts";
import type { HouseholdSummary, SetupResult } from "../types.ts";

function progressLine(count: number): string {
  if (count === 0) return "no trades in progress";
  return count === 1 ? "1 trade in progress" : `${count} trades in progress`;
}

function FinishSetup({ household }: { household: HouseholdSummary }) {
  const queryClient = useQueryClient();
  const finish = useMutation({
    mutationFn: () => api<SetupResult>(`/api/households/${encodeURIComponent(household.id)}/finish-setup`, { method: "POST" }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["households"] }),
  });
  if (finish.isPending) return <span className="ml-3 text-sm text-muted">Creating the trading wallet…</span>;
  return (
    <>
      <TextButton className="ml-3" onClick={() => finish.mutate()}>
        Finish setup
      </TextButton>
      {finish.error && <span className="ml-3 text-sm text-error">{finish.error.message}</span>}
    </>
  );
}

function HouseholdRow({ household }: { household: HouseholdSummary }) {
  const total = totalValue(household.safekeeping, household.trading);
  return (
    <tr className="hover:bg-white">
      <td className="border-b border-hairline px-3 py-2">
        <Link to={`/households/${household.id}`} className="flex min-h-12 items-center text-base font-medium text-ink underline decoration-[#c9c9c4] underline-offset-4">
          {household.name}
        </Link>
      </td>
      <td className="border-b border-hairline px-3 py-2 text-right text-base font-medium">{usd(total)}</td>
      <td className="border-b border-hairline py-2 pr-3 pl-10 text-base text-label">
        {lastActivity(household)}
        {!household.ready && <FinishSetup household={household} />}
      </td>
    </tr>
  );
}

export function Households() {
  const query = useHouseholds();
  const [adding, setAdding] = useState(false);
  const data = query.data;
  const byId = new Map(data?.households.map((h) => [h.id, h]));

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-[34px] font-semibold tracking-[-0.035em]">Clients</h1>
          {data && (
            <p className="m-0 text-base text-muted">
              <span className="font-medium text-ink">{usd(data.aum_usd)}</span> under management ·{" "}
              {progressLine(data.active_trades.length)}
            </p>
          )}
        </div>
        <Button onClick={() => setAdding(true)}>
          <Plus aria-hidden className="size-4" strokeWidth={2} />
          Add client
        </Button>
      </div>

      {data && data.active_trades.length > 0 && (
        <section aria-label="In progress" className="flex flex-col">
          <h2 className="m-0 mb-2 text-sm font-medium text-muted">In progress</h2>
          {data.active_trades.map((trade) => {
            const household = byId.get(trade.household_id);
            const last = household?.last_trade;
            return (
              <Link
                key={trade.id}
                to={`/trades/${trade.id}`}
                className="-mt-px flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 border-y border-hairline px-1 text-base text-ink no-underline"
              >
                <span className="min-w-[140px] font-medium">{household?.name}</span>
                <span className="flex-[1_1_240px]">{last?.id === trade.id ? tradeTitle(last) : ""}</span>
                <StatusDot tone="motion" className="text-sm">
                  {statusWord(trade.status)}
                </StatusDot>
                <Chevron />
              </Link>
            );
          })}
        </section>
      )}

      <section aria-label="Clients" className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-base">
          <thead>
            <tr className="text-left text-sm text-label">
              <th scope="col" className="border-b border-ink px-3 pb-3 font-medium">
                Client
              </th>
              <th scope="col" className="border-b border-ink px-3 pb-3 text-right font-medium">
                Value
              </th>
              <th scope="col" className="border-b border-ink pr-3 pb-3 pl-10 font-medium">
                Last activity
              </th>
            </tr>
          </thead>
          <tbody>
            {data?.households.map((household) => <HouseholdRow key={household.id} household={household} />)}
          </tbody>
        </table>
        {query.isPending && <Loading />}
        {query.error && <ErrorLine>{query.error.message}</ErrorLine>}
        {data?.households.length === 0 && (
          <p className="m-0 border-b border-hairline px-1 py-5 text-sm text-muted">Add your first client to get started.</p>
        )}
      </section>

      {adding && <AddHousehold onClose={() => setAdding(false)} />}
    </div>
  );
}
