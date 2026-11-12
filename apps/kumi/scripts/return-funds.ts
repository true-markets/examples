import { pathToFileURL } from "node:url";
import { compareDecimal } from "../shared/amount.ts";
import { matchBalance, type AssetCatalog } from "../server/assets.ts";
import type { Household } from "../server/households.ts";
import { Stop, type Runner } from "../server/runner.ts";
import type * as gatewayModule from "../server/tm/gateway.ts";
import type { Trade } from "../server/trades.ts";

export interface ReturnFundsDeps {
  gateway: Pick<typeof gatewayModule, "organizationId" | "balances">;
  runner: Pick<Runner, "returnToSafekeeping">;
  assets: AssetCatalog;
  households: { get(orgId: string, id: string): Household | undefined };
  trades: { activeForHousehold(householdId: string): Trade | undefined };
  print: (line: string) => void;
}

// Moves everything in a household's trading wallet back to its client wallet. Returns the process exit code.
export async function returnFunds(householdId: string, deps: ReturnFundsDeps): Promise<number> {
  const { gateway, runner, assets, households, trades, print } = deps;
  const household = households.get(await gateway.organizationId(), householdId);
  if (!household) {
    print(`No client ${householdId} in this organization.`);
    return 1;
  }
  if (!household.ready) {
    print(`${household.name} has no trading wallet yet, so there is nothing to return.`);
    return 1;
  }
  const active = trades.activeForHousehold(household.id);
  if (active) {
    print(`A trade for ${household.name} is still running (${active.status}). Run this once it has stopped or completed.`);
    return 1;
  }

  const { data } = await gateway.balances(household.trading_user_id!);
  let failures = 0;
  for (const asset of [...assets.tokens, assets.usdc]) {
    const available = matchBalance(data, asset)?.available ?? "0";
    if (compareDecimal(available, "0") <= 0) {
      print(`${asset.symbol}: nothing in the trading wallet.`);
      continue;
    }
    try {
      const done = await runner.returnToSafekeeping(household, asset, available);
      print(`${asset.symbol}: completed, ${done.received} ${asset.symbol} back in the client wallet (fee ${done.fee}).`);
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      failures += 1;
      print(`${asset.symbol}: ${err.message}`);
    }
  }
  return failures === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const householdId = process.argv[2];
  if (!householdId) {
    console.error("usage: npm run return-funds -- <client id>");
    process.exitCode = 2;
    return;
  }
  const { assets, loadAssets } = await import("../server/assets.ts");
  const households = await import("../server/households.ts");
  const { createRunner } = await import("../server/runner.ts");
  const { systemClock } = await import("../server/clock.ts");
  const { solanaClient } = await import("../server/solana/client.ts");
  const gateway = await import("../server/tm/gateway.ts");
  const { tradeStore } = await import("../server/trades.ts");

  await loadAssets();
  const runner = createRunner({ gateway, solana: solanaClient, assets, trades: tradeStore, households, clock: systemClock });
  process.exitCode = await returnFunds(householdId, {
    gateway,
    runner,
    assets,
    households,
    trades: tradeStore,
    print: (line) => console.log(line),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
