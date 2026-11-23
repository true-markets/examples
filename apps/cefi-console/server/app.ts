import { Hono, type Context } from "hono";
import type { CancelResult, DefiOrderInput, ModifyOrderInput, NewOrderInput } from "../shared/api.ts";
import { isQuoterOwned, type QuoterOwned } from "../shared/orders.ts";
import type { Backend } from "./backend.ts";
import type { QuoterClient } from "./quoter.ts";
import { SimBackend } from "./sim/backend.ts";
import { errorMessage, TmError } from "./tm/errors.ts";

const DECIMAL = /^\d+(\.\d+)?$/;
// Cancels for one symbol go out a few at a time to stay well inside rate limits.
const CANCEL_CONCURRENCY = 5;

export function createApp(backend: Backend, quoter?: QuoterClient): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    const status = err instanceof TmError ? err.status : 500;
    if (status >= 500) console.error(err);
    return c.json({ error: errorMessage(err), status }, status as 400);
  });

  app.get("/api/session", async (c) => c.json({ ...(await backend.session()), quoter: quoter ? { url: quoter.url } : null }));
  app.get("/api/instruments", async (c) => c.json(await backend.instruments()));
  app.get("/api/orders", async (c) => c.json(await backend.orders()));
  app.get("/api/fills", async (c) => c.json(await backend.fills(c.req.query("recent") === "1")));

  app.post("/api/orders", async (c) => {
    const body = await json<Partial<NewOrderInput>>(c);
    const input = validateNewOrder(body);
    return c.json(await backend.placeOrder(input), 201);
  });

  app.patch("/api/orders/:id", async (c) => {
    const body = await json<Partial<ModifyOrderInput>>(c);
    if (!DECIMAL.test(body.qty ?? "") || !DECIMAL.test(body.price ?? "")) throw new TmError("qty and price must be decimal strings", 400);
    await backend.modifyOrder(c.req.param("id"), { qty: body.qty!, price: body.price! });
    return c.json({ ok: true });
  });

  app.delete("/api/orders/:id", async (c) => {
    await backend.cancelOrder(c.req.param("id"));
    return c.json({ ok: true });
  });

  // With a symbol, cancels only that instrument's orders. The exchange has no such call, so this
  // reads the active orders and cancels each one. Without a symbol, it is the exchange's cancel-all.
  // keepQuoter leaves the orders a running quoter keeps resting (see isQuoterOwned), which means
  // canceling the rest one by one, even without a symbol.
  app.post("/api/orders/cancel-all", async (c) => {
    const { symbol, keepQuoter } = await json<{ symbol?: string; keepQuoter?: QuoterOwned }>(c);
    if (!symbol && !keepQuoter) return c.json(await backend.cancelAll());
    const targets = (await backend.activeOrders()).filter((o) => (!symbol || o.symbol === symbol) && !isQuoterOwned(o, keepQuoter));
    return c.json(await cancelEach(backend, targets.map((o) => o.orderId)));
  });

  app.get("/api/balances", async (c) => c.json(await backend.balances()));
  app.get("/api/custody", async (c) => c.json(await backend.custody()));

  app.post("/api/custody/:kind", async (c) => {
    const kind = c.req.param("kind");
    const { assetId, amount } = await json<{ assetId?: string; amount?: string }>(c);
    if (!assetId || !DECIMAL.test(amount ?? "") || !(Number(amount) > 0)) throw new TmError("assetId and a positive decimal amount are required", 400);
    if (kind === "allocations") return c.json(await backend.allocate(assetId, amount!), 202);
    if (kind === "releases") return c.json(await backend.release(assetId, amount!), 202);
    return c.json({ error: "not found" }, 404);
  });

  // DeFi market orders: quote (the gateway creates the order and returns payloads, kept here), then
  // execute (the server signs them), then follow.
  app.post("/api/defi/quote", async (c) => {
    const b = await json<Partial<DefiOrderInput>>(c);
    if (!b.symbol || (b.side !== "BUY" && b.side !== "SELL") || !DECIMAL.test(b.qty ?? "") || !(Number(b.qty) > 0)) {
      throw new TmError("symbol, side (BUY or SELL) and a positive decimal qty are required", 400);
    }
    return c.json(await backend.quoteDefi({ symbol: b.symbol, side: b.side, qty: b.qty! }));
  });
  app.post("/api/defi/:id/execute", async (c) => c.json(await backend.executeDefi(c.req.param("id"))));
  app.get("/api/defi/:id", async (c) => c.json(await backend.defiOrder(c.req.param("id"))));

  // The cefi-quoter's management API, passed through. Present only when QUOTER_URL is set.
  const needQuoter = (): QuoterClient => {
    if (!quoter) throw new TmError("no quoter configured: set QUOTER_URL to the cefi-quoter's management address", 404);
    return quoter;
  };
  const bookSymbol = (raw: string): string => {
    if (!/^[A-Za-z0-9]+[-/][A-Za-z0-9]+$/.test(raw)) throw new TmError(`${raw} isn't a book symbol`, 400);
    return raw;
  };
  app.get("/api/quoter/status", async (c) => c.json(await needQuoter().status()));
  app.get("/api/quoter/trades", async (c) => c.json(await needQuoter().trades(Number(c.req.query("limit") ?? 500) || 500)));
  app.get("/api/quoter/rejects", async (c) => c.json(await needQuoter().rejects(Number(c.req.query("limit") ?? 1000) || 1000)));
  app.post("/api/quoter/books", async (c) => {
    const body = await json<{ symbol?: unknown; reference?: unknown; blend?: unknown }>(c);
    if (typeof body?.symbol !== "string") throw new TmError("send the symbol of the book to add", 400);
    const reference = typeof body.reference === "string" ? body.reference.trim() : undefined;
    return c.json(await needQuoter().addBook(bookSymbol(body.symbol), reference, blendBody(body.blend, true)));
  });
  // A blend is checked by the quoter; here it only has to be an object with a list of sources.
  const blendBody = (raw: unknown, optional = false): unknown => {
    if (raw === undefined && optional) return undefined;
    if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { sources?: unknown }).sources)) {
      throw new TmError("send a reference blend: an object with a list of sources", 400);
    }
    return raw;
  };
  app.put("/api/quoter/books/:symbol/reference", async (c) =>
    c.json(await needQuoter().setReference(bookSymbol(c.req.param("symbol")), blendBody(await json(c)))),
  );
  app.get("/api/quoter/references/:symbol/suggest", async (c) => c.json(await needQuoter().suggestSources(bookSymbol(c.req.param("symbol")))));
  app.post("/api/quoter/references/:symbol/preview", async (c) =>
    c.json(await needQuoter().previewReference(bookSymbol(c.req.param("symbol")), blendBody(await json(c)))),
  );
  app.get("/api/quoter/books/:symbol", async (c) => c.json(await needQuoter().book(bookSymbol(c.req.param("symbol")))));
  app.delete("/api/quoter/books/:symbol", async (c) => c.json(await needQuoter().removeBook(bookSymbol(c.req.param("symbol")))));
  app.get("/api/quoter/settings", async (c) => c.json(await needQuoter().settings()));
  app.patch("/api/quoter/settings", async (c) => {
    const body = await json<Record<string, unknown>>(c);
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length === 0) {
      throw new TmError("send an object of the settings to change", 400);
    }
    return c.json(await needQuoter().updateSettings(body));
  });
  app.get("/api/quoter/books/:symbol/params", async (c) => c.json(await needQuoter().params(bookSymbol(c.req.param("symbol")))));
  app.patch("/api/quoter/books/:symbol/params", async (c) => {
    const body = await json<Record<string, unknown>>(c);
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length === 0) {
      throw new TmError("send an object of the parameters to change", 400);
    }
    return c.json(await needQuoter().updateParams(bookSymbol(c.req.param("symbol")), body));
  });
  app.post("/api/quoter/books/:symbol/reset", async (c) => c.json(await needQuoter().resetPosition(bookSymbol(c.req.param("symbol")))));
  app.post("/api/quoter/books/:symbol/reset-rejects", async (c) => c.json(await needQuoter().resetRejects(bookSymbol(c.req.param("symbol")))));
  app.post("/api/quoter/reset-rejects", async (c) => c.json(await needQuoter().resetRejects()));
  app.post("/api/quoter/books/:symbol/:action{start|stop}", async (c) =>
    c.json(await needQuoter().control(c.req.param("action") as "start" | "stop", bookSymbol(c.req.param("symbol")))),
  );
  app.post("/api/quoter/:action{start|stop}", async (c) => c.json(await needQuoter().control(c.req.param("action") as "start" | "stop")));

  // Demo only: pause or resume the simulated strategy.
  app.get("/api/demo/strategy", (c) => {
    if (!(backend instanceof SimBackend)) return c.json({ error: "demo mode only" }, 404);
    return c.json({ running: backend.exchange.strategyRunning });
  });
  app.post("/api/demo/strategy", async (c) => {
    if (!(backend instanceof SimBackend)) return c.json({ error: "demo mode only" }, 404);
    const { running } = await json<{ running?: boolean }>(c);
    backend.setStrategy(running !== false);
    return c.json({ running: backend.exchange.strategyRunning });
  });

  return app;
}

export async function cancelEach(backend: Backend, ids: string[]): Promise<CancelResult> {
  const result: CancelResult = { accepted: [], failed: [] };
  const queue = [...ids];
  await Promise.all(
    Array.from({ length: Math.min(CANCEL_CONCURRENCY, queue.length) }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          await backend.cancelOrder(id);
          result.accepted.push(id);
        } catch (err) {
          result.failed.push({ orderId: id, error: errorMessage(err) });
        }
      }
    }),
  );
  return result;
}

function validateNewOrder(b: Partial<NewOrderInput>): NewOrderInput {
  if (!b.symbol) throw new TmError("symbol is required", 400);
  if (b.side !== "BUY" && b.side !== "SELL") throw new TmError("side must be BUY or SELL", 400);
  if (b.type !== "LIMIT" && b.type !== "MARKET") throw new TmError("type must be LIMIT or MARKET", 400);
  if (b.tif !== "GTC" && b.tif !== "IOC") throw new TmError("tif must be GTC or IOC", 400);
  if (!DECIMAL.test(b.qty ?? "") || !(Number(b.qty) > 0)) throw new TmError("qty must be a positive decimal string", 400);
  if (b.type === "LIMIT" && (!DECIMAL.test(b.price ?? "") || !(Number(b.price) > 0))) throw new TmError("a LIMIT order needs a positive price", 400);
  if (b.externalId && !/^[A-Za-z0-9._~-]{1,18}$|^[0-9a-f-]{36}$/.test(b.externalId)) {
    throw new TmError("externalId must be up to 18 URL-safe characters or a lowercase UUID", 400);
  }
  return {
    symbol: b.symbol,
    side: b.side,
    type: b.type,
    tif: b.type === "MARKET" ? "IOC" : b.tif,
    qty: b.qty!,
    price: b.type === "LIMIT" ? b.price : undefined,
    postOnly: b.type === "LIMIT" && b.postOnly === true,
    quoteQty: b.type === "MARKET" && b.quoteQty === true,
    externalId: b.externalId || undefined,
  };
}

async function json<T>(c: Context): Promise<T> {
  try {
    return ((await c.req.json()) ?? {}) as T;
  } catch {
    return {} as T;
  }
}
