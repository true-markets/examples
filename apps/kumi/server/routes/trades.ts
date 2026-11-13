import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { compareDecimal, fractionDigits } from "../../shared/amount.ts";
import { BELOW_MINIMUM_MESSAGE, MINIMUM_USD, sellableAmount, worthAtLeastMinimum } from "../../shared/trade-rules.ts";
import type { AppDeps } from "../app.ts";
import { tokenBySymbol } from "../assets.ts";
import * as households from "../households.ts";
import type { Household } from "../households.ts";
import { ApiError, parseJson, positiveDecimal } from "../http.ts";
import { requireAdvisor, type AppEnv } from "../session.ts";
import { newTrade, tradeStore } from "../trades.ts";
import { tradeView } from "../views.ts";
import { walletLock } from "../withdrawals.ts";
import { solanaUnavailable } from "./households.ts";

const tradeBody = z.discriminatedUnion("side", [
  z.strictObject({
    side: z.literal("buy"),
    asset: z.string().min(1),
    usd: positiveDecimal.regex(/^\d+(\.\d{1,2})?$/, "at most 2 decimal places"),
  }),
  z.strictObject({ side: z.literal("sell"), asset: z.string().min(1), qty: positiveDecimal }),
]);

const belowMinimum = () => new ApiError(422, "invalid_argument", BELOW_MINIMUM_MESSAGE, { code: "below_minimum" });

const exceedsSafekeeping = (amount: string, symbol: string) =>
  new ApiError(422, "failed_precondition", `Only ${amount} ${symbol} in the client wallet.`, { code: "exceeds_safekeeping" });

export function tradeRoutes({ gateway, solana, assets, prices, runner }: AppDeps) {
  // Validation reads safekeeping fresh, never through the display cache.
  async function safekeeping(household: Household) {
    return solana.balances(household.safekeeping_address).catch((err: unknown) => {
      throw solanaUnavailable(err);
    });
  }

  return new Hono<AppEnv>()
    .post("/households/:id/trades", requireAdvisor, async (c) => {
      const household = households.get(await gateway.organizationId(), c.req.param("id"));
      if (!household) throw new ApiError(404, "not_found", "client not found");
      const body = await parseJson(c, tradeBody);
      const token = tokenBySymbol(assets, body.asset);
      if (!token) throw new ApiError(400, "invalid_argument", `asset: ${body.asset} is not offered for trading`);
      if (body.side === "sell" && fractionDigits(body.qty) > token.decimals) {
        throw new ApiError(400, "invalid_argument", `qty: at most ${token.decimals} decimal places`);
      }

      if (!household.ready) {
        throw new ApiError(409, "failed_precondition", "Finish setting up this client before trading.", {
          code: "household_not_ready",
        });
      }
      const requireNoActiveTrade = () => {
        if (walletLock.isHeld(household.id)) {
          throw new ApiError(409, "failed_precondition", "A withdrawal is in progress for this client.", { code: "wallet_busy" });
        }
        if (tradeStore.activeForHousehold(household.id)) {
          throw new ApiError(409, "failed_precondition", "A trade for this client is already in progress.", {
            code: "trade_in_progress",
          });
        }
      };
      requireNoActiveTrade();

      if (body.side === "buy") {
        if (compareDecimal(body.usd, MINIMUM_USD) < 0) throw belowMinimum();
        const usdc = (await safekeeping(household)).tokens[assets.usdc.mint] ?? "0";
        if (compareDecimal(body.usd, usdc) > 0) throw exceedsSafekeeping(usdc, "USDC");
      } else {
        const price = prices.get(token.symbol).price;
        if (price === null) {
          throw new ApiError(503, "unavailable", `The ${token.symbol} price is not available yet. Try again in a moment.`, {
            code: "price_unavailable",
          });
        }
        if (!worthAtLeastMinimum(body.qty, price, token.decimals)) throw belowMinimum();
        const held = await safekeeping(household);
        const sellable = sellableAmount(token.symbol, token === assets.sol ? held.sol : (held.tokens[token.mint] ?? "0"));
        if (compareDecimal(body.qty, sellable) > 0) throw exceedsSafekeeping(sellable, token.symbol);
      }

      // The balance reads above yield, so a concurrent request may have started a trade since the first check.
      requireNoActiveTrade();
      const trade = tradeStore.create(
        newTrade({
          id: randomUUID(),
          household_id: household.id,
          ...body,
          placed_by: c.var.advisor.name,
          now: new Date().toISOString(),
        }),
      );
      void runner.start(trade.id);
      return c.json({ id: trade.id }, 202);
    })
    .get("/trades/:id", requireAdvisor, async (c) => {
      const trade = tradeStore.get(c.req.param("id"));
      const household = trade && households.get(await gateway.organizationId(), trade.household_id);
      if (!trade || !household) throw new ApiError(404, "not_found", "trade not found");
      return c.json(tradeView(trade));
    });
}
