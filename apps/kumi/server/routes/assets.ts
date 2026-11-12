import { Hono } from "hono";
import type { AppDeps } from "../app.ts";
import type { CatalogAsset } from "../assets.ts";
import { requireAdvisor, type AppEnv } from "../session.ts";

export function assetRoutes({ assets, prices }: AppDeps) {
  return new Hono<AppEnv>()
    .get("/assets", requireAdvisor, (c) => {
      const row = ({ symbol, name, decimals, icon }: CatalogAsset, cash: boolean) => ({
        symbol,
        name,
        decimals,
        icon,
        cash,
        price: cash ? "1" : prices.get(symbol).price,
      });
      return c.json([...assets.tokens.map((a) => row(a, false)), row(assets.usdc, true)]);
    });
}
