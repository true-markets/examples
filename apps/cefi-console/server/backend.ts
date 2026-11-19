import type {
  Balances,
  CancelResult,
  CustodyMove,
  DefiOrderInput,
  DefiOrderState,
  DefiQuote,
  FillRow,
  Instrument,
  ModifyOrderInput,
  NewOrderInput,
  OrderRow,
  Session,
} from "../shared/api.ts";
import type { SubscribeRequest } from "../shared/wire.ts";

// One browser's view of the exchange WebSocket. Messages arrive as the exchange's own JSON text.
export interface Feed {
  subscribe(req: SubscribeRequest): void;
  close(): void;
}

export interface FeedHandlers {
  message(text: string): void;
  closed(reason: string): void;
}

// Everything the routes need. LiveBackend talks to True Markets; SimBackend runs a simulated
// exchange in-process with the same message formats, so the UI cannot tell them apart.
export interface Backend {
  session(): Promise<Session>;
  instruments(): Promise<Instrument[]>;
  // Orders entered in the last 24 hours plus anything still active.
  orders(): Promise<OrderRow[]>;
  activeOrders(): Promise<OrderRow[]>;
  // The last 24 hours, or with recent only the newest page (to fill in fills that streamed in).
  fills(recent?: boolean): Promise<FillRow[]>;
  placeOrder(input: NewOrderInput): Promise<{ orderId: string }>;
  modifyOrder(orderId: string, input: ModifyOrderInput): Promise<void>;
  cancelOrder(orderId: string): Promise<void>;
  cancelAll(): Promise<CancelResult>;
  balances(): Promise<Balances>;
  custody(): Promise<CustodyMove[]>;
  allocate(assetId: string, amount: string): Promise<CustodyMove>;
  // DeFi market orders through the gateway: quote, then sign and execute, then follow.
  quoteDefi(input: DefiOrderInput): Promise<DefiQuote>;
  executeDefi(orderId: string): Promise<DefiOrderState>;
  defiOrder(orderId: string): Promise<DefiOrderState>;
  release(assetId: string, amount: string): Promise<CustodyMove>;
  openFeed(handlers: FeedHandlers): Feed;
}
