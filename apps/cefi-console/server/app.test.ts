import { describe, expect, it } from "vitest";
import type { CancelResult, OrderRow } from "../shared/api.ts";
import { createApp } from "./app.ts";
import { SimBackend } from "./sim/backend.ts";
import { SimExchange } from "./sim/exchange.ts";

// The routes run against the simulator with its timers off, so nothing moves unless a test moves it.
function setup() {
  const backend = new SimBackend(new SimExchange(undefined, 42));
  backend.setStrategy(false);
  const app = createApp(backend);
  const req = async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { backend, req };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("routes on the simulator", () => {
  it("places, lists and cancels an order", async () => {
    const { req } = setup();
    const placed = await req<{ orderId: string }>("POST", "/api/orders", { symbol: "TSLA-USDC", side: "BUY", type: "LIMIT", tif: "GTC", qty: "0.01", price: "370" });
    expect(placed.status).toBe(201);
    const orders = (await req<OrderRow[]>("GET", "/api/orders")).body;
    expect(orders.find((o) => o.orderId === placed.body.orderId)).toMatchObject({ status: "ACTIVE", side: "BUY", price: "370.00" });

    expect((await req("DELETE", `/api/orders/${placed.body.orderId}`)).status).toBe(200);
    await wait(500);
    const after = (await req<OrderRow[]>("GET", "/api/orders")).body.find((o) => o.orderId === placed.body.orderId);
    expect(after?.status).toBe("CANCELED");
  });

  it("cancels one symbol's orders and leaves the others", async () => {
    const { req } = setup();
    const a = await req<{ orderId: string }>("POST", "/api/orders", { symbol: "TSLA-USDC", side: "BUY", type: "LIMIT", tif: "GTC", qty: "0.01", price: "370" });
    const b = await req<{ orderId: string }>("POST", "/api/orders", { symbol: "NVDA-USDC", side: "BUY", type: "LIMIT", tif: "GTC", qty: "1", price: "180" });
    const res = await req<CancelResult>("POST", "/api/orders/cancel-all", { symbol: "TSLA-USDC" });
    expect(res.body.accepted).toEqual([a.body.orderId]);
    const all = await req<CancelResult>("POST", "/api/orders/cancel-all", {});
    expect(all.body.accepted).toEqual([b.body.orderId]);
  });

  it("leaves the orders a running quoter keeps resting", async () => {
    const { req } = setup();
    const order = { side: "BUY", type: "LIMIT", tif: "GTC", qty: "0.01", price: "370" };
    const quote = await req<{ orderId: string }>("POST", "/api/orders", { ...order, symbol: "TSLA-USDC", externalId: "cqtest000000000001" });
    const mine = await req<{ orderId: string }>("POST", "/api/orders", { ...order, symbol: "TSLA-USDC" });
    // The same prefix on a book the quoter isn't quoting is canceled like any other order.
    const idle = await req<{ orderId: string }>("POST", "/api/orders", { ...order, symbol: "NVDA-USDC", price: "180", externalId: "cqtest000000000002" });
    const keepQuoter = { prefix: "cq", symbols: ["TSLA-USDC"] };
    const res = await req<CancelResult>("POST", "/api/orders/cancel-all", { keepQuoter });
    expect(res.body.accepted.sort()).toEqual([mine.body.orderId, idle.body.orderId].sort());
    const symbolOnly = await req<CancelResult>("POST", "/api/orders/cancel-all", { symbol: "TSLA-USDC", keepQuoter });
    expect(symbolOnly.body.accepted).toEqual([]);
    const all = await req<CancelResult>("POST", "/api/orders/cancel-all", {});
    expect(all.body.accepted).toEqual([quote.body.orderId]);
  });

  it("rejects malformed orders before they reach the exchange", async () => {
    const { req } = setup();
    const bad = [
      { symbol: "TSLA-USDC", side: "HOLD", type: "LIMIT", tif: "GTC", qty: "1", price: "1" },
      { symbol: "TSLA-USDC", side: "BUY", type: "LIMIT", tif: "GTC", qty: "-1", price: "1" },
      { symbol: "TSLA-USDC", side: "BUY", type: "LIMIT", tif: "GTC", qty: "1" },
      { symbol: "TSLA-USDC", side: "BUY", type: "LIMIT", tif: "GTC", qty: "1", price: "380", externalId: "has spaces in it" },
    ];
    for (const body of bad) expect((await req("POST", "/api/orders", body)).status).toBe(400);
  });

  it("allocates wallet funds to CeFi and releases them", async () => {
    const { req } = setup();
    const balances = (await req<{ wallet: { assetId: string; symbol: string; chain: string; available: string; allocated: string }[] }>("GET", "/api/balances")).body;
    const usdc = balances.wallet.find((w) => w.symbol === "USDC" && w.chain === "solana")!;
    const res = await req<{ status: string }>("POST", "/api/custody/allocations", { assetId: usdc.assetId, amount: "100" });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("allocating");
    // A second allocation of the same asset while one is in flight is refused, as the API does.
    expect((await req("POST", "/api/custody/allocations", { assetId: usdc.assetId, amount: "1" })).status).toBe(409);
    expect((await req("POST", "/api/custody/releases", { assetId: usdc.assetId, amount: "1000000" })).status).toBe(422);
  });

  it("settles a simulated allocation on the exchange well before the gateway completes it", async () => {
    const { req } = setup();
    const balances = (await req<{ wallet: { assetId: string; symbol: string; chain: string }[] }>("GET", "/api/balances")).body;
    const usdc = balances.wallet.find((w) => w.symbol === "USDC" && w.chain === "solana")!;
    await req("POST", "/api/custody/allocations", { assetId: usdc.assetId, amount: "5" });
    await wait(500);
    const [m] = (await req<{ status: string; exchange?: { status: string } }[]>("GET", "/api/custody")).body;
    expect(m).toMatchObject({ exchange: { status: "COMPLETED" } });
    expect(m!.status).not.toBe("completed");
  });

  it("quotes, executes and completes a simulated DeFi buy", async () => {
    const { req } = setup();
    const q = await req<{ orderId: string; executable: boolean; assetOut: string }>("POST", "/api/defi/quote", { symbol: "TSLA-USDC", side: "BUY", qty: "100" });
    expect(q.body).toMatchObject({ executable: true, assetOut: "TSLA" });
    expect((await req("POST", `/api/defi/${q.body.orderId}/execute`)).status).toBe(200);
    await wait(1_700);
    const done = await req<{ status: string; executedQty: string }>("GET", `/api/defi/${q.body.orderId}`);
    expect(done.body.status).toBe("complete");
    expect(Number(done.body.executedQty)).toBeGreaterThan(0);
    // An unfundable quote comes back without an order to execute.
    const big = await req<{ executable: boolean; issues: string[] }>("POST", "/api/defi/quote", { symbol: "TSLA-USDC", side: "BUY", qty: "99999999" });
    expect(big.body).toMatchObject({ executable: false, issues: ["Insufficient balance"] });
  });
});
