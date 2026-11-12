import { compareDecimal, plusDecimal } from "../shared/amount.ts";
import { jsonFile } from "./store.ts";
import type { OrderDetail, OrderSide, TransferDetail } from "./tm/types.ts";

export type TradeStatus = "funding" | "buying" | "selling" | "returning" | "complete" | "stopped";
export type StepName = "move_in" | "trade" | "return";
export type StepState = "next" | "running" | "done" | "failed";

export interface Step {
  name: StepName;
  state: StepState;
  at: string | null;
  message?: string;
}

export interface Trade {
  id: string;
  household_id: string;
  side: OrderSide;
  asset: string;
  usd?: string;
  qty?: string;
  status: TradeStatus;
  steps: [Step, Step, Step];
  placed_by: string;
  created_at: string;
  move_in: { signature?: string; amount: string; asset: string };
  order: { order_id?: string; prepared_at?: string; execute_started_at?: string; fee_asset?: string; detail?: OrderDetail };
  transfer: { transfer_id?: string; prepared_at?: string; execute_started_at?: string; fee_asset?: string; detail?: TransferDetail };
}

export interface Fee {
  asset: string;
  amount: string;
}

export interface TradeResult {
  spent: string;
  received: string;
  avg_price: string;
  fees: Fee[];
}

// Fees stay in the asset they were taken in; entries for one asset are added, never converted across assets.
export function tradeResult(trade: Trade): TradeResult | undefined {
  const order = trade.order.detail;
  const transfer = trade.transfer.detail;
  if (trade.status !== "complete" || !order || !transfer) return undefined;

  const charged: Fee[] = [];
  if (trade.order.fee_asset) charged.push({ asset: trade.order.fee_asset, amount: order.fee });
  if (trade.transfer.fee_asset) charged.push({ asset: trade.transfer.fee_asset, amount: transfer.fee });

  const fees: Fee[] = [];
  for (const fee of charged) {
    if (compareDecimal(fee.amount, "0") === 0) continue;
    const same = fees.find((f) => f.asset === fee.asset);
    if (same) same.amount = plusDecimal(same.amount, fee.amount);
    else fees.push({ ...fee });
  }

  return {
    spent: (trade.side === "buy" ? trade.usd : trade.qty)!,
    received: transfer.received,
    avg_price: order.executed_vwap,
    fees,
  };
}

const TERMINAL: readonly TradeStatus[] = ["complete", "stopped"];

export function isTerminal(status: TradeStatus): boolean {
  return TERMINAL.includes(status);
}

export function newTrade(input: {
  id: string;
  household_id: string;
  side: OrderSide;
  asset: string;
  usd?: string;
  qty?: string;
  placed_by: string;
  now: string;
}): Trade {
  const { now, ...rest } = input;
  const buy = input.side === "buy";
  return {
    ...rest,
    status: "funding",
    steps: [
      { name: "move_in", state: "running", at: now },
      { name: "trade", state: "next", at: null },
      { name: "return", state: "next", at: null },
    ],
    created_at: now,
    move_in: { amount: (buy ? input.usd : input.qty)!, asset: buy ? "USDC" : input.asset },
    order: {},
    transfer: {},
  };
}

const file = jsonFile<{ trades: Trade[] }>("trades.json", { trades: [] });

// Trades saved before more than SOL was offered carry no asset, and were all SOL: fix them once, on load.
const stored = file.read().trades;
if (stored.some((t) => !t.asset)) file.write({ trades: stored.map((t) => (t.asset ? t : { ...t, asset: "SOL" })) });

function all(): Trade[] {
  return file.read().trades;
}

export const tradeStore = {
  create(trade: Trade): Trade {
    file.write({ trades: [...all(), trade] });
    return trade;
  },

  update(trade: Trade): Trade {
    file.write({ trades: all().map((t) => (t.id === trade.id ? trade : t)) });
    return trade;
  },

  get(id: string): Trade | undefined {
    return all().find((t) => t.id === id);
  },

  listForHousehold(householdId: string): Trade[] {
    return all()
      .filter((t) => t.household_id === householdId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  latestForHousehold(householdId: string): Trade | undefined {
    return all()
      .filter((t) => t.household_id === householdId)
      .reduce<Trade | undefined>((latest, t) => (!latest || t.created_at > latest.created_at ? t : latest), undefined);
  },

  activeForHousehold(householdId: string): Trade | undefined {
    return all().find((t) => t.household_id === householdId && !isTerminal(t.status));
  },

  nonTerminal(): Trade[] {
    return all().filter((t) => !isTerminal(t.status));
  },
};

export type TradeStore = typeof tradeStore;
