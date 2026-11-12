import { Hono } from "hono";
import { z } from "zod";
import { compareDecimal } from "../../shared/amount.ts";
import { addressError, maxWithdrawable, MIN_SOL_SEND, solForTokenSends, withdrawalError } from "../../shared/withdraw-rules.ts";
import type { AppDeps } from "../app.ts";
import { matchBalance, tokenBySymbol } from "../assets.ts";
import * as households from "../households.ts";
import type { Household } from "../households.ts";
import { ApiError, parseJson, positiveDecimal } from "../http.ts";
import { Stop } from "../runner.ts";
import { requireAdvisor, type AppEnv } from "../session.ts";
import { tradeStore } from "../trades.ts";
import { planTransferAll, sendFromClientWallet, SendFailed, transferAll } from "../withdraw.ts";
import { walletLock } from "../withdrawals.ts";
import { solanaUnavailable } from "./households.ts";

const withdrawalBody = z.strictObject({ asset: z.string().min(1), amount: positiveDecimal, to: z.string().min(1) });
const transferAllBody = z.strictObject({ to: z.string().min(1) });

const busy = (what: string) =>
  new ApiError(409, "failed_precondition", `${what} is in progress for this client. Try again when it has finished.`, {
    code: "wallet_busy",
  });

// Moving funds out of a client's wallets: a withdrawal to any address, and returning a trading wallet's funds to the client wallet.
export function walletRoutes({ gateway, solana, assets, runner, clock }: AppDeps) {
  async function lookup(id: string): Promise<Household> {
    const household = households.get(await gateway.organizationId(), id);
    if (!household) throw new ApiError(404, "not_found", "client not found");
    return household;
  }

  async function withWalletLock<T>(household: Household, fn: () => Promise<T>): Promise<T> {
    if (tradeStore.activeForHousehold(household.id)) throw busy("A trade");
    if (!walletLock.tryAcquire(household.id)) throw busy("A withdrawal");
    try {
      return await fn();
    } finally {
      walletLock.release(household.id);
    }
  }

  const readHeld = (household: Household) =>
    solana.balances(household.safekeeping_address).catch((err: unknown) => {
      throw solanaUnavailable(err);
    });

  function requireAddress(to: string, household: Household): void {
    const problem = addressError(to, household.safekeeping_address);
    if (problem) throw new ApiError(400, "invalid_argument", `to: ${problem}`);
  }

  return new Hono<AppEnv>()
    .post("/households/:id/withdrawals", requireAdvisor, async (c) => {
      const household = await lookup(c.req.param("id"));
      const body = await parseJson(c, withdrawalBody);
      const asset = body.asset === assets.usdc.symbol ? assets.usdc : tokenBySymbol(assets, body.asset);
      if (!asset) throw new ApiError(400, "invalid_argument", `asset: ${body.asset} cannot be withdrawn`);
      requireAddress(body.to, household);

      return withWalletLock(household, async () => {
        const held = await readHeld(household);
        const problem = withdrawalError({
          symbol: asset.symbol,
          amount: body.amount,
          decimals: asset.decimals,
          balance: asset === assets.sol ? held.sol : (held.tokens[asset.mint] ?? "0"),
          solBalance: held.sol,
        });
        if (problem) throw new ApiError(422, "failed_precondition", problem, { code: "withdrawal_refused" });

        try {
          const done = await sendFromClientWallet({ solana, assets, clock }, household, asset, body.amount, body.to);
          return c.json({ id: done.id, status: done.status, signature: done.signature, tx_url: done.tx_url });
        } catch (err) {
          if (!(err instanceof SendFailed)) throw err;
          throw new ApiError(502, "unavailable", `The withdrawal could not be sent: ${err.message}`, { code: "send_failed" });
        }
      });
    })
    .post("/households/:id/transfer-all", requireAdvisor, async (c) => {
      const household = await lookup(c.req.param("id"));
      const { to } = await parseJson(c, transferAllBody);
      requireAddress(to, household);

      return withWalletLock(household, async () => {
        const held = await readHeld(household);
        const plan = planTransferAll(held, assets);
        if (plan.length === 0 && compareDecimal(maxWithdrawable("SOL", held.sol), MIN_SOL_SEND) < 0) {
          throw new ApiError(422, "failed_precondition", "The client wallet holds nothing to transfer.", { code: "withdrawal_refused" });
        }
        const feeFloor = solForTokenSends(plan.length);
        if (compareDecimal(held.sol, feeFloor) < 0) {
          throw new ApiError(422, "failed_precondition", `Keep about ${feeFloor} SOL in the client wallet to pay network fees.`, {
            code: "withdrawal_refused",
          });
        }
        const done = await transferAll({ solana, assets, clock }, household, plan, to, async () => (await readHeld(household)).sol);
        return c.json(done);
      });
    })
    .post("/households/:id/return-funds", requireAdvisor, async (c) => {
      const household = await lookup(c.req.param("id"));
      if (!household.ready) {
        throw new ApiError(409, "failed_precondition", "This client has no trading wallet yet.", { code: "household_not_ready" });
      }
      return withWalletLock(household, async () => {
        const { data } = await gateway.balances(household.trading_user_id!);
        const results: { symbol: string; ok: boolean; received?: string; message?: string }[] = [];
        for (const asset of [...assets.tokens, assets.usdc]) {
          const available = matchBalance(data, asset)?.available ?? "0";
          if (compareDecimal(available, "0") <= 0) continue;
          try {
            const done = await runner.returnToSafekeeping(household, asset, available);
            results.push({ symbol: asset.symbol, ok: true, received: done.received });
          } catch (err) {
            if (!(err instanceof Stop)) throw err;
            results.push({ symbol: asset.symbol, ok: false, message: err.message });
          }
        }
        return c.json({ results });
      });
    });
}
