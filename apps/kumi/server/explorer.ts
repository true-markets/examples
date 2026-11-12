import type { StepName, Trade } from "./trades.ts";

export function solscanTx(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

// Conductor's single-order read carries no explorer link, so the order's is built from its tx_hash.
export function tradeLinks(trade: Trade): Partial<Record<StepName, string>> {
  const signature = trade.move_in.signature;
  const orderTx = trade.order.detail?.tx_hash;
  const transfer = trade.transfer.detail;
  return {
    move_in: signature ? solscanTx(signature) : undefined,
    trade: orderTx ? solscanTx(orderTx) : undefined,
    return: transfer?.explorer_url ?? (transfer?.tx_hash ? solscanTx(transfer.tx_hash) : undefined),
  };
}
