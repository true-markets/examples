import { tradeLinks } from "./explorer.ts";
import type { Household } from "./households.ts";
import { tradeResult, type Trade } from "./trades.ts";

export function publicHousehold(household: Household) {
  const { id, name, created_at, ready, safekeeping_address, trading_address } = household;
  return { id, name, created_at, ready, safekeeping_address, trading_address };
}

export function tradeSummary(trade: Trade) {
  const { id, side, asset, status, usd, qty, created_at } = trade;
  const received = status === "complete" ? trade.transfer.detail?.received : undefined;
  return { id, side, asset, status, usd, qty, received, created_at };
}

export function tradeView(trade: Trade) {
  const { id, household_id, side, asset, status, usd, qty, placed_by, created_at } = trade;
  const links = tradeLinks(trade);
  return {
    id,
    household_id,
    side,
    asset,
    status,
    usd,
    qty,
    steps: trade.steps.map((s) => ({ ...s, tx_url: s.state === "done" ? links[s.name] : undefined })),
    result: tradeResult(trade),
    placed_by,
    created_at,
  };
}
