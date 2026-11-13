import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "./clock.ts";
import type { SolanaClient } from "./solana/client.ts";
import { balanceRow, JUP_MINT, SAFEKEEPING_ADDRESS, TRADING_ADDRESS, testCatalog, testHousehold, USDC_MINT, useTempDataDir } from "./testing.ts";
import type * as gatewayModule from "./tm/gateway.ts";
import type { CreateOrderResponse, OrderDetail, TransferDetail } from "./tm/types.ts";
import type { Trade } from "./trades.ts";

type Gateway = typeof gatewayModule;

useTempDataDir("kumi-runner-");

const START = Date.parse("2026-11-11T10:00:00Z");

const HOUSEHOLD = testHousehold();

let log: { call: string; at: number }[];
let now: number;

const clock: Clock = {
  now: () => now,
  sleep: async (ms) => {
    now += ms;
  },
};

function preparedOrder(id: string): CreateOrderResponse {
  return {
    order_id: id,
    status: "initialized",
    payloads: [{ digest: "d1", payload: `${id}-payload` }],
    quote: { base_asset: "sol-mint", quote_asset: USDC_MINT, qty: "10", qty_out: "0.0548", fee: "0.02", fee_asset: USDC_MINT },
  };
}

function order(status: string, overrides: Partial<OrderDetail> = {}): OrderDetail {
  return {
    order_id: "order-1",
    base_asset: "SOL",
    quote_asset: "USDC",
    type: "market",
    side: "buy",
    price: null,
    qty: "10",
    qty_unit: "quote",
    executed_qty: "0.0548",
    leaves_qty: "0",
    executed_vwap: "182.2",
    fee: "0.02",
    tx_hash: "order-tx",
    venue: "defi",
    status,
    created_at: "2026-11-11T10:00:00Z",
    ...overrides,
  };
}

function transfer(status: string, overrides: Partial<TransferDetail> = {}): TransferDetail {
  return {
    id: "transfer-1",
    status,
    venue: "defi",
    asset_id: testCatalog.sol.id,
    asset_symbol: "SOL",
    chain: "solana",
    network: null,
    to: SAFEKEEPING_ADDRESS,
    qty: "0.0548",
    qty_unit: "base",
    sent: "0.0548",
    fee: "0.0001",
    received: "0.0547",
    tx_hash: "transfer-tx",
    explorer_url: "https://solscan.io/tx/transfer-tx",
    payloads: [{ digest: "d1", payload: "transfer-1-payload" }],
    created_at: "2026-11-11T10:00:00Z",
    updated_at: "2026-11-11T10:00:00Z",
    ...overrides,
  };
}

function logged<A extends unknown[], R>(call: string, impl: (...args: A) => Promise<R>) {
  return vi.fn(async (...args: A) => {
    log.push({ call, at: now });
    return impl(...args);
  });
}

// A trading wallet that receives the move in on the second balances read and the proceeds once the order completes.
function fakeGateway(side: "buy" | "sell" = "buy", symbol = "SOL") {
  const moved = side === "buy" ? balanceRow("USDC", "10") : balanceRow(symbol, symbol === "SOL" ? "0.05" : "12");
  const proceeds = side === "buy" ? balanceRow(symbol, "0.0548") : balanceRow("USDC", "9.11");
  let reads = 0;
  let filled = false;
  return {
    balances: logged<[string], Awaited<ReturnType<Gateway["balances"]>>>("balances", async () => {
      reads += 1;
      if (filled) return { data: [proceeds] };
      return { data: reads >= 2 ? [moved] : [] };
    }),
    createOrder: logged<Parameters<Gateway["createOrder"]>, CreateOrderResponse>("createOrder", async () => preparedOrder("order-1")),
    executeOrder: logged<Parameters<Gateway["executeOrder"]>, { status: string }>("executeOrder", async () => ({ status: "pending" })),
    getOrder: logged<Parameters<Gateway["getOrder"]>, OrderDetail>("getOrder", async (_u, id) => {
      filled = true;
      return order("complete", { order_id: id, side });
    }),
    createTransfer: logged<Parameters<Gateway["createTransfer"]>, TransferDetail>("createTransfer", async () =>
      transfer("awaiting_signature"),
    ),
    executeTransfer: logged<Parameters<Gateway["executeTransfer"]>, TransferDetail>("executeTransfer", async () =>
      transfer("pending"),
    ),
    getTransfer: logged<Parameters<Gateway["getTransfer"]>, TransferDetail>("getTransfer", async () => {
      filled = false;
      return side === "buy" ? transfer("completed") : transfer("completed", { asset_symbol: "USDC", fee: "0.01", received: "9.10" });
    }),
  };
}

function fakeSolana() {
  return {
    balances: vi.fn<SolanaClient["balances"]>(async () => ({ sol: "1", tokens: {} })),
    sendToken: vi.fn<SolanaClient["sendToken"]>(async ({ onSigned }) => {
      log.push({ call: "sendToken", at: now });
      onSigned("move-in-sig");
      return "move-in-sig";
    }),
    sendSol: vi.fn<SolanaClient["sendSol"]>(async ({ onSigned }) => {
      log.push({ call: "sendSol", at: now });
      onSigned("move-in-sig");
      return "move-in-sig";
    }),
    status: vi.fn<SolanaClient["status"]>(async () => "confirmed"),
  };
}

let runnerModule: typeof import("./runner.ts");
let tradesModule: typeof import("./trades.ts");
let TMError: typeof import("./tm/errors.ts").TMError;
let gateway: ReturnType<typeof fakeGateway>;
let solana: ReturnType<typeof fakeSolana>;

beforeEach(async () => {
  runnerModule = await import("./runner.ts");
  tradesModule = await import("./trades.ts");
  ({ TMError } = await import("./tm/errors.ts"));
  log = [];
  now = START;
  gateway = fakeGateway();
  solana = fakeSolana();
});

function runner() {
  return runnerModule.createRunner({
    gateway,
    solana,
    assets: testCatalog,
    trades: tradesModule.tradeStore,
    households: { byId: (id) => (id === HOUSEHOLD.id ? HOUSEHOLD : undefined) },
    clock,
  });
}

function place(side: "buy" | "sell", change: (t: Trade) => void = () => {}, asset = "SOL"): Trade {
  const trade = tradesModule.newTrade({
    id: `trade-${side}`,
    household_id: HOUSEHOLD.id,
    side,
    asset,
    ...(side === "buy" ? { usd: "10" } : { qty: asset === "SOL" ? "0.05" : "12" }),
    placed_by: "Hana Sato",
    now: new Date(now).toISOString(),
  });
  change(trade);
  return tradesModule.tradeStore.create(trade);
}

function stored(id: string): Trade {
  return tradesModule.tradeStore.get(id)!;
}

function sequence(): string[] {
  return log.map((e) => e.call).filter((call, i, all) => call !== all[i - 1]);
}

function failedStep(trade: Trade) {
  return trade.steps.find((s) => s.state === "failed");
}

describe("buy", () => {
  it("moves the USDC in, buys, returns the whole SOL balance and completes", async () => {
    const trade = place("buy");

    await runner().start(trade.id);

    expect(sequence()).toEqual([
      "sendToken",
      "balances",
      "createOrder",
      "executeOrder",
      "getOrder",
      "balances",
      "createTransfer",
      "executeTransfer",
      "getTransfer",
    ]);
    expect(solana.sendToken.mock.calls[0]![0]).toMatchObject({
      householdId: HOUSEHOLD.id,
      to: TRADING_ADDRESS,
      mint: USDC_MINT,
      decimals: 6,
      amount: "10",
    });
    expect(gateway.createOrder.mock.calls[0]).toEqual([
      "user-1",
      { asset_id: testCatalog.sol.id, chain: "solana", side: "buy", qty: "10", qty_unit: "quote", venue: "defi" },
    ]);
    expect(gateway.createTransfer.mock.calls[0]).toEqual([
      "user-1",
      { asset_id: testCatalog.sol.id, qty: "0.0548", to: SAFEKEEPING_ADDRESS },
    ]);

    const done = stored(trade.id);
    expect(done.status).toBe("complete");
    expect(done.steps.map((s) => s.state)).toEqual(["done", "done", "done"]);
    expect(done.move_in.signature).toBe("move-in-sig");
    expect(tradesModule.tradeResult(done)).toEqual({
      spent: "10",
      received: "0.0547",
      avg_price: "182.2",
      fees: [
        { asset: "USDC", amount: "0.02" },
        { asset: "SOL", amount: "0.0001" },
      ],
    });
  });

  it("records the move-in signature before the send resolves", async () => {
    let recordedDuringSend: string | undefined;
    solana.sendToken.mockImplementationOnce(async ({ onSigned }) => {
      onSigned("move-in-sig");
      recordedDuringSend = stored("trade-buy").move_in.signature;
      return "move-in-sig";
    });

    await runner().start(place("buy").id);

    expect(recordedDuringSend).toBe("move-in-sig");
  });

  it("writes execute_started_at before executing the order", async () => {
    let startedBeforeExecute: string | undefined;
    gateway.executeOrder.mockImplementationOnce(async () => {
      startedBeforeExecute = stored("trade-buy").order.execute_started_at;
      return { status: "pending" };
    });

    await runner().start(place("buy").id);

    expect(startedBeforeExecute).toBeDefined();
  });
});

describe("sell", () => {
  it("moves the SOL in, sells in base units and returns the USDC", async () => {
    gateway = fakeGateway("sell");
    const trade = place("sell");

    await runner().start(trade.id);

    expect(solana.sendSol.mock.calls[0]![0]).toMatchObject({ to: TRADING_ADDRESS, amount: "0.05" });
    expect(solana.sendToken).not.toHaveBeenCalled();
    expect(gateway.createOrder.mock.calls[0]![1]).toMatchObject({ side: "sell", qty: "0.05", qty_unit: "base", venue: "defi" });
    expect(gateway.createTransfer.mock.calls[0]![1]).toEqual({ asset_id: testCatalog.usdc.id, qty: "9.11", to: SAFEKEEPING_ADDRESS });
    const done = stored(trade.id);
    expect(done.status).toBe("complete");
    expect(tradesModule.tradeResult(done)).toMatchObject({ spent: "0.05", received: "9.10", fees: [{ asset: "USDC", amount: "0.03" }] });
  });
});

describe("another token", () => {
  it("buys a token's listing and returns that token to the client wallet", async () => {
    gateway = fakeGateway("buy", "JUP");
    const trade = place("buy", undefined, "JUP");

    await runner().start(trade.id);

    expect(gateway.createOrder.mock.calls[0]![1]).toMatchObject({ asset_id: "jup-id", side: "buy", qty: "10", qty_unit: "quote" });
    expect(gateway.createTransfer.mock.calls[0]![1]).toEqual({ asset_id: "jup-id", qty: "0.0548", to: SAFEKEEPING_ADDRESS });
    expect(solana.sendToken.mock.calls[0]![0]).toMatchObject({ mint: USDC_MINT, amount: "10" });
    expect(stored(trade.id)).toMatchObject({ status: "complete", asset: "JUP" });
  });

  it("sells a token by moving it in as a token, not as SOL, and returns USDC", async () => {
    gateway = fakeGateway("sell", "JUP");
    const trade = place("sell", undefined, "JUP");

    await runner().start(trade.id);

    expect(solana.sendSol).not.toHaveBeenCalled();
    expect(solana.sendToken.mock.calls[0]![0]).toMatchObject({ mint: JUP_MINT, decimals: 6, amount: "12", to: TRADING_ADDRESS });
    expect(gateway.createOrder.mock.calls[0]![1]).toMatchObject({ asset_id: "jup-id", side: "sell", qty: "12", qty_unit: "base" });
    expect(gateway.createTransfer.mock.calls[0]![1]).toEqual({ asset_id: testCatalog.usdc.id, qty: "9.11", to: SAFEKEEPING_ADDRESS });
    expect(stored(trade.id).status).toBe("complete");
  });
});

describe("stops", () => {
  it.each([
    ["an empty order_id", () => gateway.createOrder.mockResolvedValueOnce({ ...preparedOrder(""), payloads: [] })],
    [
      "a quote with issues",
      () =>
        gateway.createOrder.mockResolvedValueOnce({
          ...preparedOrder("order-1"),
          quote: { ...preparedOrder("order-1").quote!, issues: ["insufficient balance"] },
        }),
    ],
    [
      "a 422 on create",
      () =>
        gateway.createOrder.mockRejectedValueOnce(
          new TMError(422, { type: "failed_precondition", message: "insufficient balance" }),
        ),
    ],
  ])("stops at the trade step on %s, leaving funds in place", async (name, arrange) => {
    arrange();
    const trade = place("buy");

    await runner().start(trade.id);

    const stopped = stored(trade.id);
    expect(stopped.status, name).toBe("stopped");
    expect(failedStep(stopped), name).toMatchObject({ name: "trade", message: expect.stringContaining("The order could not be placed") });
    expect(gateway.executeOrder, name).not.toHaveBeenCalled();
    expect(gateway.createTransfer, name).not.toHaveBeenCalled();
  });

  it("stops at the move in when the funds never arrive within 120s", async () => {
    gateway.balances.mockImplementation(async () => {
      log.push({ call: "balances", at: now });
      return { data: [] };
    });
    const trade = place("buy");

    await runner().start(trade.id);

    const stopped = stored(trade.id);
    expect(stopped.status).toBe("stopped");
    expect(failedStep(stopped)).toMatchObject({ name: "move_in" });
    expect(now - START).toBeGreaterThanOrEqual(120_000);
    expect(gateway.createOrder).not.toHaveBeenCalled();
  });

  it("stops when the order fails, without moving anything back", async () => {
    gateway.getOrder.mockImplementation(async () => order("failed", { failure_reason: "slippage exceeded" }));
    const trade = place("buy");

    await runner().start(trade.id);

    const stopped = stored(trade.id);
    expect(stopped.status).toBe("stopped");
    expect(failedStep(stopped)).toMatchObject({ name: "trade", message: "The order failed: slippage exceeded" });
    expect(gateway.createTransfer).not.toHaveBeenCalled();
  });

  it("stops at the move in when the send fails before signing, naming the cause", async () => {
    solana.sendToken.mockRejectedValueOnce(new Error("rpc down"));
    const trade = place("buy");

    await runner().start(trade.id);

    const stopped = stored(trade.id);
    expect(stopped.status).toBe("stopped");
    expect(failedStep(stopped)).toMatchObject({ name: "move_in", message: "The move in could not be sent: rpc down" });
    expect(stopped.move_in.signature).toBeUndefined();
    expect(gateway.createOrder).not.toHaveBeenCalled();
  });

  it("stops at the move in without the cause when the send failed after signing", async () => {
    solana.sendToken.mockImplementationOnce(async ({ onSigned }) => {
      onSigned("move-in-sig");
      throw new Error("rpc down");
    });
    const trade = place("buy");

    await runner().start(trade.id);

    const stopped = stored(trade.id);
    expect(failedStep(stopped)).toMatchObject({
      name: "move_in",
      message: "Move in did not confirm. Check the client wallet before trying again.",
    });
    expect(stopped.move_in.signature).toBe("move-in-sig");
    expect(gateway.createOrder).not.toHaveBeenCalled();
  });

  it("stops at the return step when the move back fails, leaving the proceeds in the trading wallet", async () => {
    gateway.getTransfer.mockImplementation(async () => transfer("failed"));
    const trade = place("buy");

    await runner().start(trade.id);

    const stopped = stored(trade.id);
    expect(stopped.status).toBe("stopped");
    expect(failedStep(stopped)).toMatchObject({ name: "return", message: "The move back to the client wallet failed." });
    expect(gateway.executeTransfer).toHaveBeenCalledTimes(1);
  });
});

describe("resume", () => {
  const executing = (t: Trade) => {
    t.status = "buying";
    t.steps[0].state = "done";
    t.steps[1].state = "running";
    t.move_in.signature = "move-in-sig";
  };

  it("polls an order that was executed and never executes it again", async () => {
    gateway.getOrder.mockResolvedValueOnce(order("pending"));
    const trade = place("buy", (t) => {
      executing(t);
      t.order = { order_id: "order-1", prepared_at: "2026-11-11T09:59:00Z", execute_started_at: "2026-11-11T09:59:01Z", fee_asset: "USDC" };
    });

    await runner().resumeAll();

    expect(gateway.createOrder).not.toHaveBeenCalled();
    expect(gateway.executeOrder).not.toHaveBeenCalled();
    expect(stored(trade.id).status).toBe("complete");
  });

  it("prepares a new order when the recorded one was never executed", async () => {
    gateway.createOrder.mockResolvedValueOnce(preparedOrder("order-2"));
    const trade = place("buy", (t) => {
      executing(t);
      t.order = { order_id: "order-1", prepared_at: "2026-11-11T09:59:00Z" };
    });

    await runner().resumeAll();

    expect(gateway.createOrder).toHaveBeenCalledTimes(1);
    expect(gateway.executeOrder.mock.calls[0]![1]).toBe("order-2");
    expect(stored(trade.id).status).toBe("complete");
  });

  it("prepares a new order when an executed one is still awaiting its signature", async () => {
    gateway.getOrder.mockResolvedValueOnce(order("initialized"));
    gateway.createOrder.mockResolvedValueOnce(preparedOrder("order-2"));
    place("buy", (t) => {
      executing(t);
      t.order = { order_id: "order-1", prepared_at: "2026-11-11T09:59:00Z", execute_started_at: "2026-11-11T09:59:01Z" };
    });

    await runner().resumeAll();

    expect(gateway.executeOrder.mock.calls.map((c) => c[1])).toEqual(["order-2"]);
  });

  it("polls a transfer that was executed and never executes it again", async () => {
    const trade = place("buy", (t) => {
      t.status = "returning";
      t.steps[0].state = "done";
      t.steps[1].state = "done";
      t.steps[2].state = "running";
      t.transfer = { transfer_id: "transfer-1", prepared_at: "2026-11-11T09:59:00Z", execute_started_at: "2026-11-11T09:59:01Z" };
    });
    gateway.getTransfer.mockResolvedValueOnce(transfer("pending"));

    await runner().resumeAll();

    expect(gateway.createTransfer).not.toHaveBeenCalled();
    expect(gateway.executeTransfer).not.toHaveBeenCalled();
    expect(stored(trade.id).status).toBe("complete");
  });

  it("stops a move in that never confirmed and never sends it again", async () => {
    solana.status.mockResolvedValue("unknown");
    const trade = place("buy", (t) => {
      t.move_in.signature = "move-in-sig";
    });

    await runner().resumeAll();

    const stopped = stored(trade.id);
    expect(stopped.status).toBe("stopped");
    expect(failedStep(stopped)).toMatchObject({
      name: "move_in",
      message: "Move in did not confirm. Check the client wallet before trying again.",
    });
    expect(solana.sendToken).not.toHaveBeenCalled();
    expect(gateway.balances).not.toHaveBeenCalled();
  });

  it("goes on to arrival when the recorded move in confirmed", async () => {
    const trade = place("buy", (t) => {
      t.move_in.signature = "move-in-sig";
    });

    await runner().resumeAll();

    expect(solana.sendToken).not.toHaveBeenCalled();
    expect(stored(trade.id).status).toBe("complete");
  });

  it("stops a trade whose move in was never sent", async () => {
    const trade = place("buy");

    await runner().resumeAll();

    expect(failedStep(stored(trade.id))).toMatchObject({ name: "move_in", message: "Kumi restarted before the move in was sent." });
    expect(solana.sendToken).not.toHaveBeenCalled();
  });
});

describe("preservation", () => {
  it("executes each order and transfer once, even when started twice", async () => {
    const trade = place("buy");
    const run = runner();

    await Promise.all([run.start(trade.id), run.start(trade.id)]);

    expect(stored(trade.id).status).toBe("complete");
    expect(gateway.executeOrder).toHaveBeenCalledTimes(1);
    expect(gateway.executeTransfer).toHaveBeenCalledTimes(1);
    expect(solana.sendToken).toHaveBeenCalledTimes(1);
  });
});

describe("poll budget", () => {
  it("makes no more than 20 gateway calls in any 60s", async () => {
    let reads = 0;
    let filled = false;
    gateway.balances.mockImplementation(async () => {
      log.push({ call: "balances", at: now });
      reads += 1;
      if (filled) return { data: [balanceRow("SOL", "0.0548")] };
      return { data: reads >= 30 ? [balanceRow("USDC", "10")] : [] };
    });
    let orderReads = 0;
    gateway.getOrder.mockImplementation(async (_u, id) => {
      log.push({ call: "getOrder", at: now });
      orderReads += 1;
      filled = orderReads >= 15;
      return order(filled ? "complete" : "pending", { order_id: id });
    });
    const trade = place("buy");

    await runner().start(trade.id);

    const gatewayCalls = log.filter((e) => e.call !== "sendToken").map((e) => e.at);
    const busiest = Math.max(...gatewayCalls.map((t) => gatewayCalls.filter((u) => u >= t && u < t + 60_000).length));
    expect(stored(trade.id).status).toBe("complete");
    expect(busiest).toBeLessThanOrEqual(20);
  });
});
