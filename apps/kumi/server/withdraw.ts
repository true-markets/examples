import { randomUUID } from "node:crypto";
import { compareDecimal } from "../shared/amount.ts";
import { maxWithdrawable, MIN_SOL_SEND } from "../shared/withdraw-rules.ts";
import type { AssetCatalog, CatalogAsset } from "./assets.ts";
import type { Clock } from "./clock.ts";
import { solscanTx } from "./explorer.ts";
import type { Household } from "./households.ts";
import type { SolanaClient } from "./solana/client.ts";
import { waitForConfirmation, type Confirmation } from "./solana/confirm.ts";
import { errorMessage } from "./tm/errors.ts";
import { withdrawalStore, type Withdrawal } from "./withdrawals.ts";

export class SendFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendFailed";
  }
}

interface SendDeps {
  solana: SolanaClient;
  assets: AssetCatalog;
  clock: Clock;
}

export interface SendOutcome {
  id: string;
  symbol: string;
  amount: string;
  status: Confirmation;
  signature: string;
  tx_url: string;
}

// Sends from a client wallet and waits for the network. The record carries the signature before anything is broadcast.
export async function sendFromClientWallet(
  { solana, assets, clock }: SendDeps,
  household: Household,
  asset: CatalogAsset,
  amount: string,
  to: string,
): Promise<SendOutcome> {
  let record: Withdrawal = {
    id: randomUUID(),
    household_id: household.id,
    asset: asset.symbol,
    amount,
    to,
    status: "sending",
    created_at: new Date().toISOString(),
  };
  withdrawalStore.create(record);
  const send = {
    householdId: household.id,
    to,
    amount,
    onSigned: (signature: string) => {
      record = { ...record, signature };
      withdrawalStore.update(record);
    },
  };
  try {
    if (asset.mint === assets.sol.mint) await solana.sendSol(send);
    else await solana.sendToken({ ...send, mint: asset.mint, decimals: asset.decimals });
  } catch (err) {
    withdrawalStore.update({ ...record, status: "failed", message: errorMessage(err) });
    throw new SendFailed(errorMessage(err));
  }

  const signature = record.signature!;
  const status = await waitForConfirmation(solana, signature, clock);
  withdrawalStore.update({ ...record, status });
  return { id: record.id, symbol: asset.symbol, amount, status, signature, tx_url: solscanTx(signature) };
}

export interface Holdings {
  sol: string;
  tokens: Record<string, string>;
}

// Everything but SOL that a full transfer moves first: USDC, then each offered token the wallet holds.
export function planTransferAll(held: Holdings, assets: AssetCatalog): { asset: CatalogAsset; amount: string }[] {
  const candidates = [assets.usdc, ...assets.tokens.filter((a) => a.mint !== assets.sol.mint)];
  return candidates
    .map((asset) => ({ asset, amount: held.tokens[asset.mint] ?? "0" }))
    .filter(({ amount }) => compareDecimal(amount, "0") > 0);
}

export interface TransferResult {
  symbol: string;
  amount: string;
  status: Confirmation;
  signature?: string;
  tx_url?: string;
  message?: string;
}

// Tokens go first, each confirmed before the next. SOL goes last, from a fresh balance, so the fees the tokens cost are already paid.
export async function transferAll(
  deps: SendDeps,
  household: Household,
  plan: { asset: CatalogAsset; amount: string }[],
  to: string,
  readSol: () => Promise<string>,
): Promise<{ results: TransferResult[]; stopped: boolean; left: string[] }> {
  const results: TransferResult[] = [];
  const run = async (asset: CatalogAsset, amount: string): Promise<boolean> => {
    try {
      const done = await sendFromClientWallet(deps, household, asset, amount, to);
      results.push({ symbol: asset.symbol, amount, status: done.status, signature: done.signature, tx_url: done.tx_url });
      return done.status === "confirmed";
    } catch (err) {
      if (!(err instanceof SendFailed)) throw err;
      results.push({ symbol: asset.symbol, amount, status: "failed", message: err.message });
      return false;
    }
  };
  for (const { asset, amount } of plan) {
    if (!(await run(asset, amount))) return { results, stopped: true, left: [] };
  }
  const solLeft = maxWithdrawable("SOL", await readSol());
  if (compareDecimal(solLeft, MIN_SOL_SEND) >= 0) {
    const ok = await run(deps.assets.sol, solLeft);
    return { results, stopped: !ok, left: [] };
  }
  return { results, stopped: false, left: compareDecimal(solLeft, "0") > 0 ? ["SOL"] : [] };
}
