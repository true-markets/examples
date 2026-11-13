import { useMemo } from "react";
import { allocationAfter, amountIn, positions, type AllocationChange } from "../../positions.ts";
import { assetName } from "../../format.ts";
import { buyChips, estimate, sellChips, validate, type Chip } from "../../trade-input.ts";
import type { AssetRow, HouseholdSummary, Side } from "../../types.ts";

export interface TradeDraft {
  offered: AssetRow[];
  asset: AssetRow;
  // What the client holds of the asset being traded, and of the cash side.
  held: string;
  usdc: string;
  heldBySymbol: Record<string, string>;
  error: string | null;
  youGet: string;
  change: AllocationChange[] | null;
  chips: Chip[];
}

// Everything the trade form shows that depends on what was typed, worked out in one place.
export function useTradeDraft(
  household: HouseholdSummary,
  assets: readonly AssetRow[] | undefined,
  side: Side,
  symbol: string,
  amount: string,
): TradeDraft {
  const offered = useMemo(() => (assets ?? []).filter((a) => !a.cash), [assets]);
  const heldBySymbol = useMemo(() => ({ SOL: household.safekeeping.sol, ...household.safekeeping.tokens }), [household.safekeeping]);
  const rows = useMemo(() => positions(household.safekeeping, household.trading, assets ?? []), [household, assets]);

  const asset = offered.find((a) => a.symbol === symbol) ?? { symbol, name: assetName(symbol), decimals: 9, icon: null, cash: false, price: null };
  const held = amountIn(household.safekeeping, symbol) ?? "0";
  const { usdc } = household.safekeeping;
  const error = validate(side, amount, { usdc, asset: held }, asset.price, asset);
  const youGet = estimate(side, amount, asset.price, symbol) ?? "–";
  const usdAmount = side === "buy" ? Number(amount) : Number(amount) * Number(asset.price);
  const change = amount !== "" && error === null && asset.price !== null ? allocationAfter(rows, side, symbol, usdAmount) : null;
  const chips = side === "buy" ? buyChips(usdc) : sellChips(asset, held);

  return { offered, asset, held, usdc, heldBySymbol, error, youGet, change, chips };
}
