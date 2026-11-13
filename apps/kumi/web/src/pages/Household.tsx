import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { api, isTerminal, useAssets, useHousehold } from "../api.ts";
import { TradePanel } from "../components/TradePanel.tsx";
import { Wallets } from "../components/Wallets.tsx";
import {
  AssetLogo,
  Breadcrumb,
  Button,
  ButtonLink,
  CopyButton,
  ErrorLine,
  Loading,
  Mono,
  ShareBar,
  StatusDot,
} from "../components/ui.tsx";
import { DASH, monthYear, quantity, shortDate, statusTone, statusWord, tokenAmount, totalValue, tradeTitle, unitPrice, usd } from "../format.ts";
import { allocation, allocationColors, assetBySymbol, isEmpty, positions, type Position } from "../positions.ts";
import type { HouseholdDetail, SetupResult } from "../types.ts";

function Allocation({ rows }: { rows: Position[] }) {
  const shares = allocation(rows);
  const colors = allocationColors(shares.map((s) => s.symbol));
  const unpriced = rows.some((r) => r.value === null && Number(r.quantity) > 0);
  return (
    <div className="flex flex-col gap-3">
      <ShareBar segments={shares.map((share) => ({ key: share.symbol, pct: share.pct, color: colors[share.symbol]! }))} />
      <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 p-0 text-sm text-label">
        {shares.map((share) => (
          <li key={share.symbol} className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 rounded-full" style={{ background: colors[share.symbol] }} />
            {share.symbol} {share.pct}%
          </li>
        ))}
        {shares.length === 0 && <li className="text-muted">{unpriced ? "Waiting for prices" : "Nothing held yet"}</li>}
      </ul>
    </div>
  );
}

function FundingPanel({ address }: { address: string }) {
  return (
    <section aria-label="Fund this client wallet" className="flex flex-col gap-3 rounded-2xl border border-hairline bg-white p-6">
      <h2 className="m-0 text-base font-semibold">Fund this client wallet to place a trade</h2>
      <p className="m-0 max-w-[620px] text-base leading-relaxed text-label">
        Send USDC on Solana to this address, plus about 0.02 SOL that stays here to pay network fees.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Mono className="text-sm break-all">{address}</Mono>
        <CopyButton value={address} />
      </div>
    </section>
  );
}

function FinishSetupButton({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const finish = useMutation({
    mutationFn: () => api<SetupResult>(`/api/households/${encodeURIComponent(id)}/finish-setup`, { method: "POST" }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["household", id] });
      void queryClient.invalidateQueries({ queryKey: ["households"] });
    },
  });
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" disabled={finish.isPending} onClick={() => finish.mutate()}>
        {finish.isPending ? "Creating the trading wallet…" : "Finish setup"}
      </Button>
      {finish.data && !finish.data.ready && (
        <span className="text-sm text-error">Trading wallet not created yet. Use Finish setup to try again.</span>
      )}
      {finish.error && <span className="text-sm text-error">{finish.error.message}</span>}
    </div>
  );
}

const TH = "border-b border-ink px-3 pb-3 text-sm font-medium text-label";
const TD = "border-b border-hairline px-3 py-4";

export function Household() {
  const { id = "" } = useParams();
  const query = useHousehold(id);
  const assets = useAssets();
  const [trading, setTrading] = useState(false);
  const data = query.data;
  const rows = useMemo(() => (data ? positions(data.safekeeping, data.trading, assets.data ?? []) : []), [data, assets.data]);
  const shares = useMemo(() => new Map(allocation(rows).map((s) => [s.symbol, s.pct])), [rows]);

  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorLine>{query.error.message}</ErrorLine>;

  const household = query.data;
  const total = totalValue(household.safekeeping, household.trading);
  const active = household.last_trade && !isTerminal(household.last_trade.status) ? household.last_trade : null;
  const unfunded = isEmpty(household.safekeeping);
  const iconOf = (symbol: string) => assetBySymbol(assets.data, symbol)?.icon ?? null;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-6">
        <Breadcrumb items={[{ label: "Clients", to: "/" }, { label: household.name }]} />
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="flex flex-col gap-2">
            <h1 className="m-0 text-[34px] font-semibold tracking-[-0.035em]">{household.name}</h1>
            <span className="text-base text-muted">Client since {monthYear(household.created_at)}</span>
          </div>
          {!household.ready && <FinishSetupButton id={household.id} />}
          {household.ready && active && (
            <ButtonLink variant="secondary" to={`/trades/${active.id}`}>
              Trade in progress
            </ButtonLink>
          )}
          {household.ready && !active && (
            <Button onClick={() => setTrading(true)} disabled={unfunded}>
              New trade
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm text-muted">Total value</span>
          <span className="text-[44px] leading-none font-medium tracking-[-0.04em]">{usd(total)}</span>
        </div>
        <Allocation rows={rows} />
      </div>

      {household.ready && unfunded && <FundingPanel address={household.safekeeping_address} />}

      <section aria-label="Holdings" className="overflow-x-auto">
        <h2 className="m-0 mb-3 text-base font-semibold">Holdings</h2>
        <table className="w-full min-w-[680px] border-collapse text-base">
          <thead>
            <tr className="text-left">
              <th scope="col" className={TH}>Asset</th>
              <th scope="col" className={`${TH} text-right`}>Quantity</th>
              <th scope="col" className={`${TH} text-right`}>Price</th>
              <th scope="col" className={`${TH} text-right`}>Value</th>
              <th scope="col" className={`${TH} text-right`}>% of total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.symbol}>
                <td className={TD}>
                  <span className="flex items-center gap-3">
                    <AssetLogo symbol={row.symbol} icon={row.icon} size={32} />
                    <span className="flex flex-col">
                      <span className="font-medium">{row.symbol}</span>
                      <span className="text-sm text-muted">{row.name}</span>
                    </span>
                  </span>
                </td>
                <td className={`${TD} text-right`}>
                  {quantity(row.quantity, row.symbol)}
                  {row.inTransit && <span className="block text-sm text-motion">{tokenAmount(row.inTransit, row.symbol)} in transit</span>}
                </td>
                <td className={`${TD} text-right text-label`}>{unitPrice(row.price)}</td>
                <td className={`${TD} text-right font-medium`}>{Number(row.quantity) > 0 ? usd(row.value) : DASH}</td>
                <td className={`${TD} text-right text-label`}>{shares.has(row.symbol) ? `${shares.get(row.symbol)}%` : DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label="Trades" className="flex flex-col">
        <h2 className="m-0 mb-3 text-base font-semibold">Trades</h2>
        <div className="grid grid-cols-[1fr_96px_150px_24px] gap-x-4 border-b border-ink px-3 pb-3 text-sm font-medium text-label">
          <span>Trade</span>
          <span>Date</span>
          <span>Status</span>
          <span />
        </div>
        {household.trades.map((trade) => (
          <Link
            key={trade.id}
            to={`/trades/${trade.id}`}
            className="grid min-h-16 grid-cols-[1fr_96px_150px_24px] items-center gap-x-4 border-b border-hairline px-3 text-base text-ink no-underline hover:bg-white"
          >
            <span className="flex min-w-0 items-center gap-3 font-medium">
              <AssetLogo symbol={trade.asset} icon={iconOf(trade.asset)} size={28} />
              <span className="truncate">{tradeTitle(trade)}</span>
            </span>
            <span className="text-base text-label">{shortDate(trade.created_at)}</span>
            <StatusDot tone={statusTone(trade.status)} className="text-base">
              {statusWord(trade.status)}
            </StatusDot>
            <ChevronRight aria-hidden className="size-4 text-muted" />
          </Link>
        ))}
        {household.trades.length === 0 && <p className="m-0 border-b border-hairline px-3 py-6 text-base text-muted">No trades yet.</p>}
      </section>

      <Wallets household={household} tradeActive={active !== null} />

      {trading && <TradePanel household={household} onClose={() => setTrading(false)} />}
    </div>
  );
}
