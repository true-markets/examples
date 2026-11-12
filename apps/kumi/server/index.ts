import { serve } from "@hono/node-server";
import { ensureDemoAdvisor } from "./advisors.ts";
import { createApp } from "./app.ts";
import { assets, loadAssets } from "./assets.ts";
import { env } from "./env.ts";
import * as households from "./households.ts";
import { prices, startPricePoller } from "./prices.ts";
import { systemClock } from "./clock.ts";
import { createRunner } from "./runner.ts";
import { DATA_DIR } from "./secrets.ts";
import { solanaClient } from "./solana/client.ts";
import { TM_API_URL } from "./tm/client.ts";
import * as gateway from "./tm/gateway.ts";
import { walletSigner } from "./tm/stamp.ts";
import { orgKeyFile } from "./tm/token.ts";
import { tradeStore } from "./trades.ts";

ensureDemoAdvisor();
const catalog = await loadAssets();
startPricePoller(catalog.tokens.map((a) => a.symbol));

const runner = createRunner({ gateway, solana: solanaClient, assets, trades: tradeStore, households, clock: systemClock });
void runner.resumeAll();

const app = createApp({ gateway, solana: solanaClient, assets, prices, runner, clock: systemClock });

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`listening on :${info.port} (True Markets at ${TM_API_URL}, org key file ${orgKeyFile})`);
  console.log(
    [
      "",
      "Kumi is running",
      `  Open     http://localhost:5180 with npm run dev, or http://localhost:${info.port} for the built app`,
      "  Sign in  hana.sato@kumi.example / kumi-demo (filled in for you)",
      "  Funds    these are real, on Solana mainnet; see the README to withdraw them",
      "",
    ].join("\n"),
  );
});

if (walletSigner.created) {
  console.warn(
    `created the wallet signer key at ${walletSigner.file}: it signs for every client's trading wallet, so back it up before funding any; deleting it locks those accounts for good`,
  );
}
console.warn(`safekeeping keys are in ${DATA_DIR}/safekeeping-keys; losing one loses that client's funds`);
