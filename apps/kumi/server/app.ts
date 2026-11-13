import { existsSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { AssetCatalog } from "./assets.ts";
import type { Clock } from "./clock.ts";
import { ApiError, errorResponse } from "./http.ts";
import type { PriceBook } from "./prices.ts";
import { authRoutes } from "./routes/auth.ts";
import { householdRoutes } from "./routes/households.ts";
import { assetRoutes } from "./routes/assets.ts";
import { tradeRoutes } from "./routes/trades.ts";
import { walletRoutes } from "./routes/wallets.ts";
import type { Runner } from "./runner.ts";
import type { SolanaClient } from "./solana/client.ts";
import type * as gateway from "./tm/gateway.ts";

export interface AppDeps {
  gateway: typeof gateway;
  solana: SolanaClient;
  assets: AssetCatalog;
  prices: PriceBook;
  runner: Pick<Runner, "start" | "returnToSafekeeping">;
  clock: Clock;
}

const DIST = "./dist";

export function createApp(deps: AppDeps) {
  const app = new Hono()
    .route("/api", authRoutes())
    .route("/api", assetRoutes(deps))
    .route("/api", householdRoutes(deps))
    .route("/api", tradeRoutes(deps))
    .route("/api", walletRoutes(deps))
    .all("/api/*", () => {
      throw new ApiError(404, "not_found", "not found");
    });

  app.onError(errorResponse);

  if (existsSync(DIST)) {
    app.use("*", serveStatic({ root: DIST }));
    app.get("*", serveStatic({ path: `${DIST}/index.html` }));
  }

  return app;
}
