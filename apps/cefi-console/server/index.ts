import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.ts";
import type { Backend } from "./backend.ts";
import { loadConfig } from "./env.ts";
import { LiveBackend } from "./live.ts";
import { attachRelay } from "./relay.ts";
import { SimBackend } from "./sim/backend.ts";

const config = loadConfig();

let backend: Backend;
if (config.mode === "live") {
  backend = new LiveBackend(config);
} else {
  const sim = new SimBackend();
  sim.exchange.start();
  backend = sim;
}

const app = createApp(backend);
// After `npm run build`, the same port serves the web app.
if (existsSync("dist")) {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ path: "./dist/index.html" }));
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  const where = config.mode === "live" ? `LIVE on ${config.environment} with ${config.keyFile}` : "DEMO against the built-in simulator";
  console.log(`CeFi console server on http://127.0.0.1:${info.port} — ${where}`);
  if (config.mode === "live") console.log("Orders you place, modify or cancel here are real.");
});
attachRelay(server as Server, backend);
