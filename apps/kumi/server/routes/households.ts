import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { matchBalance, type CatalogAsset } from "../assets.ts";
import { createBalanceCache } from "../balance-cache.ts";
import * as households from "../households.ts";
import type { Household } from "../households.ts";
import { ApiError, parseJson } from "../http.ts";
import { requireAdvisor, type AppEnv } from "../session.ts";
import { errorMessage } from "../tm/errors.ts";
import type { BalanceItem } from "../tm/types.ts";
import { tradeStore } from "../trades.ts";
import { publicHousehold, tradeSummary } from "../views.ts";

const householdBody = z.strictObject({ name: z.string().trim().min(1).max(60) });

interface Holding {
  address: string;
  sol: string;
  usdc: string;
  // Every other offered token the wallet holds, by symbol; zero balances are left out.
  tokens: Record<string, string>;
  value_usd: string | null;
}

const isHeld = (amount: string) => Number(amount) > 0;

export function solanaUnavailable(err: unknown): ApiError {
  return new ApiError(502, "unavailable", `The Solana network could not be read (${errorMessage(err)})`);
}

export function householdRoutes({ gateway, solana, assets, prices }: AppDeps) {
  const safekeepingCache = createBalanceCache<{ sol: string; tokens: Record<string, string> }>();
  const tradingCache = createBalanceCache<BalanceItem[]>();

  // An estimate for the screen only; amounts sent anywhere never go through floats. Null when a held asset has no price yet.
  function valueUsd(sol: string, usdc: string, tokens: Record<string, string>): string | null {
    let total = Number(usdc);
    for (const [symbol, amount] of Object.entries({ SOL: sol, ...tokens })) {
      if (!isHeld(amount)) continue;
      const price = prices.get(symbol).price;
      if (price === null) return null;
      total += Number(amount) * Number(price);
    }
    return total.toFixed(2);
  }

  function holding(address: string, amountOf: (asset: CatalogAsset) => string): Holding {
    const sol = amountOf(assets.sol);
    const usdc = amountOf(assets.usdc);
    const tokens: Record<string, string> = {};
    for (const token of assets.tokens) {
      const amount = token === assets.sol ? "0" : amountOf(token);
      if (isHeld(amount)) tokens[token.symbol] = amount;
    }
    return { address, sol, usdc, tokens, value_usd: valueUsd(sol, usdc, tokens) };
  }

  async function safekeeping(household: Household): Promise<Holding> {
    const { sol, tokens } = await safekeepingCache(household.id, () =>
      solana.balances(household.safekeeping_address).catch((err: unknown) => {
        throw solanaUnavailable(err);
      }),
    );
    return holding(household.safekeeping_address, (asset) => (asset === assets.sol ? sol : (tokens[asset.mint] ?? "0")));
  }

  async function trading(household: Household): Promise<Holding | null> {
    if (!household.ready) return null;
    try {
      const rows = await tradingCache(household.id, async () => (await gateway.balances(household.trading_user_id!)).data);
      // Defi leaves zero balances out, so a missing row from a successful read is zero.
      return holding(household.trading_address!, (asset) => matchBalance(rows, asset)?.available ?? "0");
    } catch (err) {
      console.warn(`trading balances for household ${household.id} failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async function summary(household: Household) {
    const [safe, trade] = await Promise.all([safekeeping(household), trading(household)]);
    const last = tradeStore.latestForHousehold(household.id);
    return {
      ...publicHousehold(household),
      safekeeping: safe,
      trading: trade,
      last_trade: last ? tradeSummary(last) : null,
    };
  }

  async function lookup(id: string): Promise<Household> {
    const household = households.get(await gateway.organizationId(), id);
    if (!household) throw new ApiError(404, "not_found", "client not found");
    return household;
  }

  return new Hono<AppEnv>()
    .get("/households", requireAdvisor, async (c) => {
      const list = households.listForOrg(await gateway.organizationId());
      const summaries = await Promise.all(list.map(summary));
      const values = summaries.flatMap((h) => [h.safekeeping.value_usd, ...(h.trading ? [h.trading.value_usd] : [])]);
      const priced = values.every((v) => v !== null);
      const aum = values.reduce((sum, v) => sum + Number(v), 0);
      const ids = new Set(list.map((h) => h.id));
      return c.json({
        households: summaries,
        aum_usd: priced ? aum.toFixed(2) : null,
        active_trades: tradeStore
          .nonTerminal()
          .filter((t) => ids.has(t.household_id))
          .map(({ id, household_id, status }) => ({ id, household_id, status })),
      });
    })
    .post("/households", requireAdvisor, async (c) => {
      const { name } = await parseJson(c, householdBody);
      const household = await households.addHousehold(name, { gateway });
      return c.json({ household: publicHousehold(household), ready: household.ready }, 201);
    })
    .post("/households/:id/finish-setup", requireAdvisor, async (c) => {
      const household = await households.finishSetup(await lookup(c.req.param("id")), { gateway });
      return c.json({ household: publicHousehold(household), ready: household.ready });
    })
    .get("/households/:id", requireAdvisor, async (c) => {
      const household = await lookup(c.req.param("id"));
      return c.json({
        ...(await summary(household)),
        trades: tradeStore.listForHousehold(household.id).map(tradeSummary),
      });
    });
}
