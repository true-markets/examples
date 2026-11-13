export type Side = "buy" | "sell";
export type TradeStatus = "funding" | "buying" | "selling" | "returning" | "complete" | "stopped";
export type StepName = "move_in" | "trade" | "return";
export type StepState = "next" | "running" | "done" | "failed";

export interface Me {
  email: string;
  name: string;
}

export interface TradeSummary {
  id: string;
  side: Side;
  asset: string;
  status: TradeStatus;
  usd?: string;
  qty?: string;
  received?: string;
  created_at: string;
}

export interface AssetRow {
  symbol: string;
  name: string;
  decimals: number;
  icon: string | null;
  // USDC, the cash side of every trade, is listed but is not a tradeable pick.
  cash: boolean;
  price: string | null;
}

export interface Holding {
  address: string;
  sol: string;
  usdc: string;
  tokens: Record<string, string>;
  value_usd: string | null;
}

export interface PublicHousehold {
  id: string;
  name: string;
  created_at: string;
  ready: boolean;
  safekeeping_address: string;
  trading_address: string | null;
}

export interface HouseholdSummary extends PublicHousehold {
  safekeeping: Holding;
  trading: Holding | null;
  last_trade: TradeSummary | null;
}

export interface HouseholdDetail extends HouseholdSummary {
  trades: TradeSummary[];
}

export interface HouseholdsResponse {
  households: HouseholdSummary[];
  aum_usd: string | null;
  active_trades: { id: string; household_id: string; status: TradeStatus }[];
}

export interface SetupResult {
  household: PublicHousehold;
  ready: boolean;
}

export interface Step {
  name: StepName;
  state: StepState;
  at: string | null;
  tx_url?: string;
  message?: string;
}

export interface Fee {
  asset: string;
  amount: string;
}

export interface TradeDetail {
  id: string;
  household_id: string;
  side: Side;
  asset: string;
  status: TradeStatus;
  usd?: string;
  qty?: string;
  steps: Step[];
  result?: { spent: string; received: string; avg_price: string; fees: Fee[] };
  placed_by: string;
  created_at: string;
}
