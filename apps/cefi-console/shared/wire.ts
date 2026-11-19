// Messages on the CeFi WebSocket (wss://api.truemarkets.co/v1/cefi/market), as the exchange sends them.
// Source: https://docs.truemarkets.co/asyncapi/cefi-direct.yaml, checked against the live feed.
// Every number is a decimal string and every timestamp is Unix nanoseconds as a string.

export type Side = "BUY" | "SELL";

export type Channel = "INSTRUMENT" | "EBBO" | "DEPTH" | "TRADE" | "AUCTION" | "INDEX" | "DROPCOPY" | "HEARTBEAT";

export type SubscriptionType = "SUBSCRIBE" | "UNSUBSCRIBE" | "SUBSCRIBE_NO_AUTH" | "UNSUBSCRIBE_NO_AUTH";

// What the browser sends to this app's server. The server adds the timestamp, key and signature
// (and the client id for DROPCOPY) before passing it to the exchange, so no credential reaches the browser.
export interface SubscribeRequest {
  type: "SUBSCRIBE" | "UNSUBSCRIBE";
  channels: Channel[];
  item_names: string[];
}

// What the exchange receives.
export interface SignedSubscription {
  type: SubscriptionType;
  channels: Channel[];
  item_names: string[];
  timestamp: string;
  organization_id?: string;
  key?: string;
  signature?: string;
}

export interface Level {
  price: string;
  qty: string;
  // The live feed sends order_count; the spec calls it depth. Read either.
  order_count?: string;
  depth?: string;
  last_update?: string;
}

export interface WelcomeMessage {
  channel: "WEBSOCKET";
  update: "WELCOME";
  message?: string;
  version?: string;
  connections?: string;
  datetime?: string;
}

export interface ConfirmationMessage {
  channel: "WEBSOCKET";
  update: "SNAPSHOT" | "UPDATE";
  timestamp?: string;
  status: "INVALID" | "ERROR" | "UNAUTHORIZED" | "UNAUTHENTICATED" | "AUTHENTICATED";
  message?: string;
  subscriptions: { channel: Channel; item_names: string[] }[];
}

export interface HeartbeatMessage {
  channel: "HEARTBEAT";
  update: "HEARTBEAT";
  timestamp: string;
}

export interface SnapshotComplete<C extends Channel> {
  seqnum: string;
  channel: C;
  update: "SNAPSHOT_COMPLETE";
  item: string;
}

interface Data<C extends Channel, T> {
  seqnum: string;
  channel: C;
  update: "SNAPSHOT" | "UPDATE";
  data: T;
}

export interface InstrumentData {
  id: string;
  status: "DISABLED" | "OPENING" | "ACTIVE" | "HALTED" | "INVALID";
  info: {
    symbol: string;
    reference_price?: string;
    base_asset_id?: string;
    quote_asset_id?: string;
    price_limit_window_secs?: string;
    price_limit_percent?: string;
    price_bands_percent?: string;
  };
  stats?: { last_24hr_notional?: string; last_24hr_quantity?: string };
}

export interface EbboData {
  id?: string;
  symbol: string;
  info: {
    last_trade?: { price: string; qty: string; timestamp?: string };
    best_bid?: Level;
    best_ask?: Level;
    last_update?: string;
  };
}

export interface DepthData {
  symbol: string;
  bids?: Level[];
  asks?: Level[];
}

export interface TradeData {
  match_id: string;
  taking_side: Side;
  symbol: string;
  info: { price: string; qty: string; timestamp: string };
}

export type OrderStatus =
  | "INITIALIZED"
  | "NEW_PENDING"
  | "ACTIVE"
  | "FILLED"
  | "CANCEL_PENDING"
  | "CANCELED"
  | "MODIFY_PENDING"
  | "REJECTED";

export type OrderType = "LIMIT" | "MARKET" | "NOTIONAL_LIMIT";
export type TimeInForce = "GTC" | "IOC";
export type OrderEvent = "NEW" | "TRADE" | "CANCELED" | "MODIFIED" | "REJECTED";

// One DROPCOPY message: the whole current state of one order, plus the event that changed it.
export interface DropcopyOrder {
  order_id: string;
  client_id?: string;
  instrument_id?: string;
  external_id?: string;
  symbol: string;
  side: Side;
  order_type: OrderType;
  time_in_force: TimeInForce;
  status: OrderStatus;
  price?: string;
  quantity: string;
  leaves_qty?: string;
  executed_qty?: string;
  executed_vwap?: string;
  event_type?: OrderEvent;
  text?: string;
  trade_price?: string;
  trade_qty?: string;
  timestamp: string;
}

export type InstrumentMessage = Data<"INSTRUMENT", InstrumentData> | SnapshotComplete<"INSTRUMENT">;
export type EbboMessage = Data<"EBBO", EbboData> | SnapshotComplete<"EBBO">;
export type DepthMessage = Data<"DEPTH", DepthData> | SnapshotComplete<"DEPTH">;
export type TradeMessage = Data<"TRADE", TradeData> | SnapshotComplete<"TRADE">;
export type DropcopyMessage = Data<"DROPCOPY", DropcopyOrder> | SnapshotComplete<"DROPCOPY">;

export type ServerMessage =
  | WelcomeMessage
  | ConfirmationMessage
  | HeartbeatMessage
  | InstrumentMessage
  | EbboMessage
  | DepthMessage
  | TradeMessage
  | DropcopyMessage;

// Messages this app's server adds on the browser socket, never sent by the exchange.
export interface RelayStatus {
  channel: "RELAY";
  status: "connected" | "upstream_closed" | "error";
  message?: string;
}
