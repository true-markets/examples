import { maxWithdrawable, withdrawalError } from "../../../../shared/withdraw-rules.ts";
import { sanitizeDecimal } from "../../format.ts";
import type { AssetRow } from "../../types.ts";
import { AssetPicker } from "../AssetPicker.tsx";
import { pillClass } from "../ui.tsx";
import { AddressField, addressProblem, FIELD } from "./AddressField.tsx";

interface Props {
  assets: AssetRow[];
  held: Record<string, string>;
  symbol: string;
  amount: string;
  to: string;
  ownAddress: string;
  solBalance: string;
  onSymbol: (symbol: string) => void;
  onAmount: (amount: string) => void;
  onTo: (to: string) => void;
  onReview: () => void;
}

// The first step: which asset, how much, and where it goes.
export function WithdrawForm({ assets, held, symbol, amount, to, ownAddress, solBalance, onSymbol, onAmount, onTo, onReview }: Props) {
  const asset = assets.find((a) => a.symbol === symbol);
  const balance = held[symbol] ?? "0";
  const toError = addressProblem(to, ownAddress);
  const amountError =
    amount === "" || !asset ? null : withdrawalError({ symbol, amount, decimals: asset.decimals, balance, solBalance });
  const ready = to !== "" && toError === null && amount !== "" && amountError === null;

  return (
    <form
      className="m-0 flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onReview();
      }}
    >
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-label">Asset</span>
        <AssetPicker assets={assets} value={symbol} held={held} onChange={onSymbol} />
      </div>

      <AddressField value={to} ownAddress={ownAddress} onChange={onTo} />

      <label className="flex flex-col gap-2 text-sm font-medium text-label">
        <span className="flex items-baseline justify-between">
          Amount
          <span className="font-normal text-muted">Available {maxWithdrawable(symbol, balance)} {symbol}</span>
        </span>
        <span className="relative block">
          <input
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => onAmount(sanitizeDecimal(e.target.value))}
            placeholder="0"
            aria-invalid={amountError !== null}
            className={`${FIELD} pr-28 text-base`}
          />
          <span className="absolute inset-y-0 right-2 flex items-center gap-2">
            <span className="text-sm font-normal text-muted">{symbol}</span>
            <button
              type="button"
              onClick={() => onAmount(maxWithdrawable(symbol, balance))}
              className="h-8 cursor-pointer rounded-2xl border border-control bg-white px-3 text-sm font-medium text-ink"
            >
              Max
            </button>
          </span>
        </span>
        {amountError && (
          <span role="alert" className="text-sm font-normal text-error">
            {amountError}
          </span>
        )}
      </label>

      <button type="submit" disabled={!ready} className={pillClass("primary", "h-12 rounded-3xl text-base")}>
        Review withdrawal
      </button>
    </form>
  );
}
