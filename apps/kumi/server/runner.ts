import type { Clock } from "./clock.ts";
import { compareDecimal } from "../shared/amount.ts";
import { matchBalance, symbolOf, tokenBySymbol, type AssetCatalog, type CatalogAsset } from "./assets.ts";
import type { Household } from "./households.ts";
import type { SolanaClient } from "./solana/client.ts";
import { waitForConfirmation } from "./solana/confirm.ts";
import { errorMessage, TMError } from "./tm/errors.ts";
import type * as gatewayModule from "./tm/gateway.ts";
import { stampAll } from "./tm/stamp.ts";
import type { OrderDetail, TransferDetail, UnsignedPayload } from "./tm/types.ts";
import type { StepName, Trade, TradeStatus, TradeStore } from "./trades.ts";

type Gateway = Pick<
  typeof gatewayModule,
  "balances" | "createOrder" | "executeOrder" | "getOrder" | "createTransfer" | "executeTransfer" | "getTransfer"
>;

export interface RunnerDeps {
  gateway: Gateway;
  solana: SolanaClient;
  assets: AssetCatalog;
  trades: TradeStore;
  households: { byId(id: string): Household | undefined };
  clock: Clock;
}

export interface Runner {
  start(tradeId: string): Promise<void>;
  resumeAll(): Promise<void>;
  returnToSafekeeping(household: Household, asset: CatalogAsset, qty: string): Promise<TransferDetail>;
}

const POLL_MS = 3_000;
const STEP_TIMEOUT_MS = 120_000;
// A Solana payload carries the blockhash from prepare time, which the network drops after about a minute.
const REPREPARE_AFTER_MS = 20_000;
// Prod allows 100 calls a minute per act-as user; the runner keeps well under it so display reads still fit.
const CALLS_PER_MINUTE = 20;
const MINUTE_MS = 60_000;

const ORDER_TERMINAL = ["complete", "failed", "canceled"];
const TRANSFER_TERMINAL = ["completed", "failed"];
const NEVER_EXECUTED = ["initialized", "awaiting_signature"];

const MOVE_IN_UNCONFIRMED = "Move in did not confirm. Check the client wallet before trying again.";

export class Stop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Stop";
  }
}

type Tracked = Pick<Trade["order"], "prepared_at" | "execute_started_at">;
type TrackedTransfer = Trade["transfer"];

function stopOnTMError(what: string) {
  return (err: unknown): never => {
    if (err instanceof TMError) throw new Stop(`${what}: ${err.message}`);
    throw err;
  };
}

function notYetOnTMError(err: unknown): undefined {
  if (err instanceof TMError) return undefined;
  throw err;
}

function step(trade: Trade, name: StepName) {
  return trade.steps.find((s) => s.name === name)!;
}

export function createRunner({ gateway, solana, assets, trades, households, clock }: RunnerDeps): Runner {
  const inFlight = new Map<string, Promise<void>>();
  const calls = new Map<string, number[]>();

  const iso = () => new Date(clock.now()).toISOString();

  async function withinBudget(householdId: string): Promise<void> {
    const log = calls.get(householdId) ?? [];
    calls.set(householdId, log);
    for (;;) {
      const now = clock.now();
      while (log.length > 0 && now - log[0]! >= MINUTE_MS) log.shift();
      if (log.length < CALLS_PER_MINUTE) break;
      await clock.sleep(log[0]! + MINUTE_MS - now);
    }
    log.push(clock.now());
  }

  async function tm<T>(household: Household, call: (userId: string) => Promise<T>): Promise<T> {
    await withinBudget(household.id);
    return call(household.trading_user_id!);
  }

  async function pollUntil<T>(timeoutMs: number, intervalMs: number, read: () => Promise<T | undefined>): Promise<T | undefined> {
    const deadline = clock.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      if (clock.now() >= deadline) return undefined;
      await clock.sleep(intervalMs);
    }
  }

  async function available(household: Household, asset: CatalogAsset): Promise<string | undefined> {
    const { data } = await tm(household, (u) => gateway.balances(u));
    return matchBalance(data, asset)?.available;
  }

  async function signatureConfirmed(signature: string): Promise<boolean> {
    return (await waitForConfirmation(solana, signature, clock)) === "confirmed";
  }

  // Prepares until the payloads are fresh at the moment the execute slot is taken, then executes exactly once.
  async function prepareAndExecute(
    household: Household,
    record: Tracked,
    persist: () => void,
    prepare: () => Promise<{ id: string; payloads: UnsignedPayload[] }>,
    execute: (userId: string, id: string, signatures: string[]) => Promise<unknown>,
    what: string,
  ): Promise<void> {
    let prepared: { id: string; payloads: UnsignedPayload[] };
    let preparedAt: number;
    do {
      prepared = await prepare();
      preparedAt = clock.now();
      record.prepared_at = iso();
      persist();
      await withinBudget(household.id);
    } while (clock.now() - preparedAt > REPREPARE_AFTER_MS);

    record.execute_started_at = iso();
    persist();
    await execute(household.trading_user_id!, prepared.id, stampAll(prepared.payloads)).catch(stopOnTMError(what));
  }

  async function moveIn(household: Household, trade: Trade, resume: boolean, persist: () => void): Promise<void> {
    const asset = trade.move_in.asset === "USDC" ? assets.usdc : tokenBySymbol(assets, trade.move_in.asset)!;

    if (resume) {
      if (!trade.move_in.signature) throw new Stop("Kumi restarted before the move in was sent.");
    } else {
      const send = {
        householdId: household.id,
        to: household.trading_address!,
        amount: trade.move_in.amount,
        onSigned: (signature: string) => {
          trade.move_in.signature = signature;
          persist();
        },
      };
      try {
        if (asset.mint === assets.sol.mint) await solana.sendSol(send);
        else await solana.sendToken({ ...send, mint: asset.mint, decimals: asset.decimals });
      } catch (err) {
        console.warn(`move in for trade ${trade.id} failed: ${errorMessage(err)}`);
        throw new Stop(trade.move_in.signature ? MOVE_IN_UNCONFIRMED : `The move in could not be sent: ${errorMessage(err)}`);
      }
    }
    if (!(await signatureConfirmed(trade.move_in.signature!))) throw new Stop(MOVE_IN_UNCONFIRMED);

    const arrived = await pollUntil(STEP_TIMEOUT_MS, POLL_MS, async () => {
      const amount = await available(household, asset).catch(notYetOnTMError);
      return amount !== undefined && compareDecimal(amount, trade.move_in.amount) >= 0 ? amount : undefined;
    });
    if (!arrived) throw new Stop(`The ${asset.symbol} did not reach the trading wallet within 2 minutes.`);
  }

  async function trade(household: Household, record: Trade, resume: boolean, persist: () => void): Promise<void> {
    const order = record.order;
    let needsOrder = true;
    if (resume && order.order_id && order.execute_started_at) {
      const first = await tm(household, (u) => gateway.getOrder(u, order.order_id!)).catch(notYetOnTMError);
      needsOrder = first !== undefined && NEVER_EXECUTED.includes(first.status);
    }

    if (needsOrder) {
      const buy = record.side === "buy";
      await prepareAndExecute(
        household,
        order,
        persist,
        async () => {
          const created = await tm(household, (u) =>
            gateway.createOrder(u, {
              asset_id: tokenBySymbol(assets, record.asset)!.id,
              chain: "solana",
              side: record.side,
              qty: (buy ? record.usd : record.qty)!,
              qty_unit: buy ? "quote" : "base",
              venue: "defi",
            }),
          ).catch(stopOnTMError("The order could not be placed"));
          const issue = created.quote?.issues?.[0];
          if (issue) throw new Stop(`The order could not be placed: ${issue}`);
          if (!created.order_id) throw new Stop("The order could not be placed: True Markets returned no order.");
          if (!created.payloads?.length) throw new Stop("The order could not be placed: True Markets returned nothing to sign.");
          order.order_id = created.order_id;
          order.execute_started_at = undefined;
          order.fee_asset = created.quote && symbolOf(assets, created.quote.fee_asset);
          return { id: created.order_id, payloads: created.payloads };
        },
        (u, id, signatures) => gateway.executeOrder(u, id, signatures),
        "The order was not accepted",
      );
    }

    const detail = await pollUntil<OrderDetail>(STEP_TIMEOUT_MS, POLL_MS, async () => {
      const read = await tm(household, (u) => gateway.getOrder(u, order.order_id!)).catch(notYetOnTMError);
      return read && ORDER_TERMINAL.includes(read.status) ? read : undefined;
    });
    if (!detail) throw new Stop("The order did not finish within 2 minutes.");
    order.detail = detail;
    persist();
    if (detail.status !== "complete") {
      throw new Stop(`The order ${detail.status}${detail.failure_reason ? `: ${detail.failure_reason}` : "."}`);
    }
  }

  async function sendBack(
    household: Household,
    asset: CatalogAsset,
    record: TrackedTransfer,
    persist: () => void,
    qty: string,
  ): Promise<TransferDetail> {
    await prepareAndExecute(
      household,
      record,
      persist,
      async () => {
        const created = await tm(household, (u) =>
          gateway.createTransfer(u, { asset_id: asset.id, qty, to: household.safekeeping_address }),
        ).catch(stopOnTMError("The move back could not be prepared"));
        if (!created.payloads?.length) throw new Stop("The move back could not be prepared: True Markets returned nothing to sign.");
        record.transfer_id = created.id;
        record.fee_asset = asset.symbol;
        record.execute_started_at = undefined;
        return { id: created.id, payloads: created.payloads };
      },
      (u, id, signatures) => gateway.executeTransfer(u, id, signatures),
      "The move back was not accepted",
    );
    return awaitTransfer(household, record, persist);
  }

  async function awaitTransfer(household: Household, record: TrackedTransfer, persist: () => void): Promise<TransferDetail> {
    const detail = await pollUntil<TransferDetail>(STEP_TIMEOUT_MS, POLL_MS, async () => {
      const read = await tm(household, (u) => gateway.getTransfer(u, record.transfer_id!)).catch(notYetOnTMError);
      return read && TRANSFER_TERMINAL.includes(read.status) ? read : undefined;
    });
    if (!detail) throw new Stop("The move back did not finish within 2 minutes.");
    record.detail = detail;
    persist();
    if (detail.status !== "completed") throw new Stop("The move back to the client wallet failed.");
    return detail;
  }

  async function returnProceeds(household: Household, record: Trade, resume: boolean, persist: () => void): Promise<void> {
    const asset = record.side === "buy" ? tokenBySymbol(assets, record.asset)! : assets.usdc;
    const transfer = record.transfer;
    if (resume && transfer.transfer_id && transfer.execute_started_at) {
      const first = await tm(household, (u) => gateway.getTransfer(u, transfer.transfer_id!)).catch(notYetOnTMError);
      if (first === undefined || !NEVER_EXECUTED.includes(first.status)) {
        await awaitTransfer(household, transfer, persist);
        return;
      }
    }

    // The whole received balance goes back, so fees and rounding never strand dust in the trading wallet.
    const received = await pollUntil(STEP_TIMEOUT_MS, POLL_MS, async () => {
      const amount = await available(household, asset).catch(notYetOnTMError);
      return amount !== undefined && compareDecimal(amount, "0") > 0 ? amount : undefined;
    });
    if (!received) throw new Stop(`The ${asset.symbol} did not show in the trading wallet within 2 minutes.`);
    await sendBack(household, asset, transfer, persist, received);
  }

  function advance(record: Trade, done: StepName, next: StepName | null, status: TradeStatus): void {
    const at = iso();
    Object.assign(step(record, done), { state: "done", at });
    if (next) Object.assign(step(record, next), { state: "running", at });
    record.status = status;
  }

  function stop(record: Trade, message: string): void {
    const failed = record.steps.find((s) => s.state === "running") ?? record.steps.find((s) => s.state === "next")!;
    Object.assign(failed, { state: "failed", at: iso(), message });
    record.status = "stopped";
    trades.update(record);
  }

  async function run(tradeId: string, resume: boolean): Promise<void> {
    const record = trades.get(tradeId)!;
    const household = households.byId(record.household_id)!;
    const persist = () => void trades.update(record);
    try {
      if (record.status === "funding") {
        await moveIn(household, record, resume, persist);
        advance(record, "move_in", "trade", record.side === "buy" ? "buying" : "selling");
        persist();
      }
      if (record.status === "buying" || record.status === "selling") {
        await trade(household, record, resume, persist);
        advance(record, "trade", "return", "returning");
        persist();
      }
      if (record.status === "returning") {
        await returnProceeds(household, record, resume, persist);
        advance(record, "return", null, "complete");
        persist();
      }
    } catch (err) {
      if (!(err instanceof Stop)) console.error(err);
      stop(record, err instanceof Stop ? err.message : `Kumi hit an unexpected error: ${errorMessage(err)}`);
    }
  }

  function launch(tradeId: string, resume: boolean): Promise<void> {
    const running = inFlight.get(tradeId);
    if (running) return running;
    const done = run(tradeId, resume).finally(() => inFlight.delete(tradeId));
    inFlight.set(tradeId, done);
    return done;
  }

  return {
    start: (tradeId) => launch(tradeId, false),
    resumeAll: async () => {
      await Promise.all(trades.nonTerminal().map((t) => launch(t.id, true)));
    },
    returnToSafekeeping: (household, asset, qty) => sendBack(household, asset, {}, () => {}, qty),
  };
}
