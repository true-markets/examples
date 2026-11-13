import { floorDecimal } from "../../../../shared/amount.ts";
import { MINIMUM_USD, sellableAmount } from "../../../../shared/trade-rules.ts";
import { tokenAmount, unitPrice, usd } from "../../format.ts";
import { chipBelowMinimum } from "../../trade-input.ts";
import type { Side } from "../../types.ts";
import { AssetPicker } from "../AssetPicker.tsx";
import { pillClass } from "../ui.tsx";
import { AllocationShift } from "./allocation.tsx";
import { AmountInput, Row, UpdatedAgo } from "./parts.tsx";
import type { TradeDraft } from "./useTradeDraft.ts";

function segment(on: boolean): string {
  return `h-[38px] cursor-pointer rounded-[19px] border-0 px-5 text-sm font-medium ${
    on ? "bg-white text-ink shadow-[0_1px_2px_rgba(12,15,20,.12)]" : "bg-transparent text-muted"
  }`;
}

interface Props {
  draft: TradeDraft;
  side: Side;
  symbol: string;
  amount: string;
  pricesUpdatedAt: number;
  position: { quantity: string; value: string | null };
  onSide: (side: Side) => void;
  onSymbol: (symbol: string) => void;
  onAmount: (amount: string) => void;
  onReview: () => void;
}

// The first step: what to trade and how much, with the checks and the effect on the client's mix as the amount is typed.
export function ComposeStep({ draft, side, symbol, amount, pricesUpdatedAt, position, onSide, onSymbol, onAmount, onReview }: Props) {
  const { asset, held, usdc, error, youGet, change, chips, offered, heldBySymbol } = draft;
  const buy = side === "buy";
  return (
    <form
      className="m-0 flex flex-col gap-7"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error) onReview();
      }}
    >
      <div className="flex flex-col gap-4">
        <div role="group" aria-label="Buy or sell" className="flex gap-0.5 self-start rounded-[22px] bg-segment p-[3px]">
          {(["buy", "sell"] as const).map((s) => (
            <button key={s} type="button" aria-pressed={side === s} onClick={() => onSide(s)} className={segment(side === s)}>
              {s === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
        <AssetPicker assets={offered} value={symbol} held={heldBySymbol} onChange={onSymbol} />
      </div>

      <p className="m-0 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[30px] leading-[1.35] font-medium tracking-[-0.03em]">
        <span>{buy ? "Buy" : "Sell"}</span>
        <label className="inline-flex items-baseline border-b-[1.5px] border-ink px-0.5">
          {buy && <span aria-hidden>$</span>}
          <AmountInput label={buy ? "Amount in US dollars" : `${symbol} to sell`} value={amount} onChange={onAmount} />
        </label>
        {buy && <span className="text-muted">of</span>}
        <span>{buy ? asset.name : symbol}</span>
      </p>

      {chips.length > 0 && (
        <div role="group" aria-label="Quick amounts" className="-mt-3 flex flex-wrap gap-2">
          {chips.map((chip) => {
            const tooSmall = chipBelowMinimum(side, chip.amount, asset.price, asset);
            const amountText = buy ? usd(chip.amount) : tokenAmount(chip.amount, symbol);
            return (
              <button
                key={chip.label}
                type="button"
                disabled={tooSmall}
                onClick={() => onAmount(chip.amount)}
                title={tooSmall ? `${amountText} is under the ${usd(MINIMUM_USD)} minimum` : amountText}
                className="h-9 cursor-pointer rounded-[18px] border border-control bg-white px-3.5 text-sm font-medium text-ink disabled:cursor-not-allowed disabled:border-hairline disabled:text-[#9aa0a8]"
              >
                {chip.label}
              </button>
            );
          })}
        </div>
      )}

      {amount !== "" && error && (
        <p role="alert" className="m-0 text-sm text-error">
          {error}
        </p>
      )}

      <dl className="m-0 flex flex-col border-t border-hairline text-sm">
        <Row label="You get">
          <span className="font-medium">{youGet}</span>
        </Row>
        <Row label="Available">
          {buy
            ? `${tokenAmount(floorDecimal(usdc, 2), "USDC")} in the client wallet`
            : `${tokenAmount(floorDecimal(sellableAmount(symbol, held), 4), symbol)} in the client wallet`}
        </Row>
        <Row label="Current position">
          {Number(position.quantity) > 0 ? (
            <>
              {tokenAmount(position.quantity, symbol)}
              {position.value !== null && <span className="block text-sm text-muted">{position.value}</span>}
            </>
          ) : (
            <span className="text-muted">None</span>
          )}
        </Row>
        {change && (
          <Row label="Allocation after trade">
            <AllocationShift change={change} />
          </Row>
        )}
        <Row label="Price">
          <span className="block">
            At market · {symbol} {unitPrice(asset.price)}
          </span>
          <span className="block text-[13px] text-muted">
            <UpdatedAgo updatedAt={pricesUpdatedAt} /> · refreshes every 15s
          </span>
        </Row>
      </dl>

      <button type="submit" disabled={error !== null} className={pillClass("primary", "h-12 rounded-3xl text-base")}>
        Review trade
      </button>
    </form>
  );
}
