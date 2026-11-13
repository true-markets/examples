import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogAsset } from "../assets.ts";
import type { Clock } from "../clock.ts";
import type { Household } from "../households.ts";
import type { PriceBook, PriceQuote } from "../prices.ts";
import type { SolanaClient } from "../solana/client.ts";
import { balanceRow, JUP_MINT, organizationUser, SAFEKEEPING_ADDRESS, TRADING_ADDRESS, testCatalog, USDC_MINT, useTempDataDir } from "../testing.ts";
import type * as gatewayModule from "../tm/gateway.ts";
import type { OrderDetail, TransferDetail } from "../tm/types.ts";

type Gateway = typeof gatewayModule;

useTempDataDir("kumi-routes-");

function fakeGateway() {
  return {
    organizationId: vi.fn<Gateway["organizationId"]>(async () => "org-1"),
    createOrganizationUser: vi.fn<Gateway["createOrganizationUser"]>(async (ref) => organizationUser(ref)),
    listAssets: vi.fn<Gateway["listAssets"]>(),
    priceHistory: vi.fn<Gateway["priceHistory"]>(),
    balances: vi.fn<Gateway["balances"]>(async () => ({ data: [balanceRow("USDC", "2.5")] })),
    createOrder: vi.fn<Gateway["createOrder"]>(),
    executeOrder: vi.fn<Gateway["executeOrder"]>(),
    getOrder: vi.fn<Gateway["getOrder"]>(),
    createTransfer: vi.fn<Gateway["createTransfer"]>(),
    executeTransfer: vi.fn<Gateway["executeTransfer"]>(),
    getTransfer: vi.fn<Gateway["getTransfer"]>(),
  } satisfies Gateway;
}

function fakeSolana() {
  return {
    balances: vi.fn<SolanaClient["balances"]>(async () => ({ sol: "1", tokens: { [USDC_MINT]: "100" } })),
    sendToken: vi.fn<SolanaClient["sendToken"]>(),
    sendSol: vi.fn<SolanaClient["sendSol"]>(),
    status: vi.fn<SolanaClient["status"]>(),
  } satisfies SolanaClient;
}

let price: PriceQuote;
let jupPrice: string | null;
const NO_PRICE: PriceQuote = { price: null, as_of: null };
const priceBook: PriceBook = {
  get: (symbol) => (symbol === "SOL" ? price : symbol === "JUP" ? { price: jupPrice, as_of: price.as_of } : NO_PRICE),
};

let app: Hono;
let gateway: ReturnType<typeof fakeGateway>;
let solana: ReturnType<typeof fakeSolana>;
let runner: {
  start: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
  returnToSafekeeping: ReturnType<typeof vi.fn<(h: Household, a: CatalogAsset, qty: string) => Promise<TransferDetail>>>;
};
let clockTime = 0;
const clock: Clock = { now: () => clockTime, sleep: async (ms) => void (clockTime += ms) };
let trades: typeof import("../trades.ts");
let TMError: typeof import("../tm/errors.ts").TMError;
let cookie: string;

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { createApp } = await import("../app.ts");
  (await import("../advisors.ts")).ensureDemoAdvisor();
  trades = await import("../trades.ts");
  ({ TMError } = await import("../tm/errors.ts"));

  gateway = fakeGateway();
  solana = fakeSolana();
  runner = { start: vi.fn(async () => {}), returnToSafekeeping: vi.fn() };
  clockTime = 0;
  price = { price: "182.40", as_of: "2026-11-11T10:00:00Z" };
  jupPrice = "0.50";
  app = createApp({ gateway, solana, assets: testCatalog, prices: priceBook, runner, clock });

  const login = await post("/api/login", { email: "hana.sato@kumi.example", password: "kumi-demo" }, "");
  cookie = (login.headers.get("Set-Cookie") ?? "").split(";")[0]!;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function post(path: string, body: unknown, withCookie = cookie) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(withCookie && { Cookie: withCookie }) },
    body: JSON.stringify(body),
  });
}

function get(path: string, withCookie = cookie) {
  return app.request(path, { headers: withCookie ? { Cookie: withCookie } : {} });
}

async function addHousehold(name = "Ōtomo and Hana Fujiwara"): Promise<string> {
  const res = await post("/api/households", { name });
  expect(res.status).toBe(201);
  return ((await res.json()) as { household: { id: string } }).household.id;
}

describe("households", () => {
  it("lists households with both balances and the total under management", async () => {
    const id = await addHousehold();

    const res = await get("/api/households");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      households: [
        expect.objectContaining({
          id,
          name: "Ōtomo and Hana Fujiwara",
          ready: true,
          safekeeping: expect.objectContaining({ sol: "1", usdc: "100", value_usd: "282.40" }),
          trading: { address: TRADING_ADDRESS, sol: "0", usdc: "2.5", tokens: {}, value_usd: "2.50" },
          last_trade: null,
        }),
      ],
      aum_usd: "284.90",
      active_trades: [],
    });
  });

  it("shows the trading wallet as unknown when the gateway balances call fails, without failing the list", async () => {
    await addHousehold();
    gateway.balances.mockRejectedValueOnce(new TMError(503, { type: "unavailable", message: "defi down" }));

    const res = await get("/api/households");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { households: { trading: unknown }[] };
    expect(body.households[0]!.trading).toBeNull();
  });

  it("leaves values and the total unpriced while the SOL price is unknown", async () => {
    await addHousehold();
    price = { price: null, as_of: null };

    const body = (await (await get("/api/households")).json()) as { aum_usd: unknown; households: { safekeeping: { value_usd: unknown } }[] };

    expect(body.aum_usd).toBeNull();
    expect(body.households[0]!.safekeeping.value_usd).toBeNull();
  });

  it("answers org_user_limit when the organization is full", async () => {
    gateway.createOrganizationUser.mockRejectedValueOnce(
      new TMError(422, { type: "failed_precondition", message: "organization has reached its user limit; contact support to raise it" }),
    );

    const res = await post("/api/households", { name: "Sixth household" });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      type: "failed_precondition",
      code: "org_user_limit",
      message: "This organization has reached its limit of 5 clients.",
    });
  });

  it("answers 201 with ready false when the trading wallet could not be created, and finishes it later", async () => {
    gateway.createOrganizationUser.mockRejectedValueOnce(new TMError(500, { type: "internal", message: "boom" }));

    const added = await post("/api/households", { name: "Okafor household" });
    const { household } = (await added.json()) as { household: { id: string }; ready: boolean };
    const finished = await post(`/api/households/${household.id}/finish-setup`, {});

    expect(added.status).toBe(201);
    expect(finished.status).toBe(200);
    expect(await finished.json()).toMatchObject({ ready: true, household: { trading_address: TRADING_ADDRESS } });
  });

  it("hides another organization's household", async () => {
    const id = await addHousehold();
    gateway.organizationId.mockResolvedValue("org-2");

    expect((await get(`/api/households/${id}`)).status).toBe(404);
    expect(((await (await get("/api/households")).json()) as { households: unknown[] }).households).toEqual([]);
  });

  it("serves both balance reads from a 10s cache per household", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await addHousehold();

    await get("/api/households");
    await get("/api/households");
    expect(gateway.balances).toHaveBeenCalledTimes(1);
    expect(solana.balances).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 11_000);
    await get("/api/households");

    expect(gateway.balances).toHaveBeenCalledTimes(2);
    expect(solana.balances).toHaveBeenCalledTimes(2);
  });

  it("shows a household with its trades newest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = await addHousehold();
    const first = (await (await post(`/api/households/${id}/trades`, { side: "buy", asset: "SOL", usd: "10" })).json()) as { id: string };
    const trade = trades.tradeStore.get(first.id)!;
    trades.tradeStore.update({ ...trade, status: "stopped" });
    vi.setSystemTime(Date.now() + 60_000);
    const second = (await (await post(`/api/households/${id}/trades`, { side: "buy", asset: "SOL", usd: "20" })).json()) as { id: string };

    const body = (await (await get(`/api/households/${id}`)).json()) as { trades: { id: string }[]; last_trade: { id: string } };

    expect(body.trades.map((t) => t.id)).toEqual([second.id, first.id]);
    expect(body.last_trade.id).toBe(second.id);
  });
});

describe("assets and token holdings", () => {
  it("lists the offered tokens with their prices", async () => {
    const res = await get("/api/assets");

    expect(await res.json()).toEqual([
      { symbol: "SOL", name: "Solana", decimals: 9, icon: null, cash: false, price: "182.40" },
      { symbol: "JUP", name: "Jupiter", decimals: 6, icon: null, cash: false, price: "0.50" },
      { symbol: "USDC", name: "USD Coin", decimals: 6, icon: null, cash: true, price: "1" },
    ]);
  });

  it("shows held tokens in both wallets and values them with their own price", async () => {
    await addHousehold();
    solana.balances.mockResolvedValue({ sol: "0", tokens: { [USDC_MINT]: "10", [JUP_MINT]: "100" } });
    gateway.balances.mockResolvedValue({ data: [balanceRow("JUP", "20")] });

    const body = (await (await get("/api/households")).json()) as {
      households: { safekeeping: unknown; trading: unknown }[];
      aum_usd: string;
    };

    expect(body.households[0]!.safekeeping).toMatchObject({ usdc: "10", tokens: { JUP: "100" }, value_usd: "60.00" });
    expect(body.households[0]!.trading).toMatchObject({ usdc: "0", tokens: { JUP: "20" }, value_usd: "10.00" });
    expect(body.aum_usd).toBe("70.00");
  });

  it("leaves a value unpriced when a held token has no price yet", async () => {
    await addHousehold();
    solana.balances.mockResolvedValue({ sol: "0", tokens: { [JUP_MINT]: "100" } });
    jupPrice = null;

    const body = (await (await get("/api/households")).json()) as {
      households: { safekeeping: { value_usd: unknown } }[];
      aum_usd: unknown;
    };

    expect(body.households[0]!.safekeeping.value_usd).toBeNull();
    expect(body.aum_usd).toBeNull();
  });
});

describe("trade validation", () => {
  let id: string;

  beforeEach(async () => {
    id = await addHousehold();
  });

  const placing = (body: unknown) => post(`/api/households/${id}/trades`, body);

  it("accepts a buy within the client wallet and starts the runner", async () => {
    const res = await placing({ side: "buy", asset: "SOL", usd: "10" });

    expect(res.status).toBe(202);
    const { id: tradeId } = (await res.json()) as { id: string };
    expect(runner.start).toHaveBeenCalledWith(tradeId);
    expect(trades.tradeStore.get(tradeId)).toMatchObject({ status: "funding", usd: "10", placed_by: "Hana Sato" });
  });

  it.each([
    ["a buy below $5.50", { side: "buy", asset: "SOL", usd: "5.49" }, 422, "below_minimum", "Trades start at $5.50."],
    ["a buy above safekeeping USDC", { side: "buy", asset: "SOL", usd: "100.01" }, 422, "exceeds_safekeeping", "Only 100 USDC in the client wallet."],
    ["a sell above SOL less the gas reserve", { side: "sell", asset: "SOL", qty: "0.991" }, 422, "exceeds_safekeeping", "Only 0.99 SOL in the client wallet."],
    ["a sell worth under $5.50", { side: "sell", asset: "SOL", qty: "0.03" }, 422, "below_minimum", "Trades start at $5.50."],
  ])("refuses %s", async (name, body, status, code, message) => {
    const res = await placing(body);

    expect(res.status, name).toBe(status);
    expect(await res.json(), name).toMatchObject({ code, message });
    expect(runner.start, name).not.toHaveBeenCalled();
  });

  it("accepts a sell of everything above the gas reserve", async () => {
    expect((await placing({ side: "sell", asset: "SOL", qty: "0.99" })).status).toBe(202);
  });

  it("refuses a second trade while one is in progress", async () => {
    await placing({ side: "buy", asset: "SOL", usd: "10" });

    const res = await placing({ side: "buy", asset: "SOL", usd: "10" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "trade_in_progress" });
  });

  it("accepts only one of two simultaneous trades for a household", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    solana.balances.mockImplementation(async () => {
      await gate;
      return { sol: "1", tokens: { [USDC_MINT]: "100" } };
    });

    const both = Promise.all([placing({ side: "buy", asset: "SOL", usd: "10" }), placing({ side: "buy", asset: "SOL", usd: "10" })]);
    await vi.waitFor(() => expect(solana.balances).toHaveBeenCalledTimes(2));
    release();
    const statuses = (await both).map((res) => res.status).sort();

    expect(statuses).toEqual([202, 409]);
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it("refuses a household whose setup is not finished", async () => {
    gateway.createOrganizationUser.mockRejectedValueOnce(new TMError(500, { type: "internal", message: "boom" }));
    const pending = await addHousehold("Okafor household");

    const res = await post(`/api/households/${pending}/trades`, { side: "buy", asset: "SOL", usd: "10" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "household_not_ready" });
  });

  it.each([
    ["an unknown field", { side: "buy", asset: "SOL", usd: "10", qty: "1" }],
    ["a third decimal on dollars", { side: "buy", asset: "SOL", usd: "10.001" }],
    ["a tenth decimal on SOL", { side: "sell", asset: "SOL", qty: "0.0000000001" }],
    ["an unknown side", { side: "hold", usd: "10" }],
  ])("answers 400 for %s", async (name, body) => {
    const res = await placing(body);

    expect(res.status, name).toBe(400);
    expect(await res.json(), name).toMatchObject({ type: "invalid_argument" });
  });

  describe("another token", () => {
    beforeEach(() => {
      solana.balances.mockResolvedValue({ sol: "1", tokens: { [USDC_MINT]: "100", [JUP_MINT]: "100" } });
    });

    it("accepts a buy of an offered token and records it", async () => {
      const res = await placing({ side: "buy", asset: "JUP", usd: "10" });

      expect(res.status).toBe(202);
      const { id: tradeId } = (await res.json()) as { id: string };
      expect(trades.tradeStore.get(tradeId)).toMatchObject({ asset: "JUP", move_in: { asset: "USDC", amount: "10" } });
    });

    it("sells all of a token, with no gas reserve held back", async () => {
      const res = await placing({ side: "sell", asset: "JUP", qty: "100" });

      expect(res.status).toBe(202);
      const { id: tradeId } = (await res.json()) as { id: string };
      expect(trades.tradeStore.get(tradeId)).toMatchObject({ asset: "JUP", move_in: { asset: "JUP", amount: "100" } });
    });

    it.each([
      ["more than is held", { side: "sell", asset: "JUP", qty: "100.1" }, 422, "exceeds_safekeeping", "Only 100 JUP in the client wallet."],
      ["worth under $5.50", { side: "sell", asset: "JUP", qty: "10.9" }, 422, "below_minimum", "Trades start at $5.50."],
    ])("refuses a token sell %s", async (name, body, status, code, message) => {
      const res = await placing(body);

      expect(res.status, name).toBe(status);
      expect(await res.json(), name).toMatchObject({ code, message });
    });

    it.each([
      ["an asset that is not offered", { side: "buy", asset: "DOGE", usd: "10" }],
      ["USDC as the asset", { side: "buy", asset: "USDC", usd: "10" }],
      ["more decimals than the token has", { side: "sell", asset: "JUP", qty: "10.1234567" }],
    ])("answers 400 for %s", async (name, body) => {
      const res = await placing(body);

      expect(res.status, name).toBe(400);
      expect(runner.start, name).not.toHaveBeenCalled();
    });
  });

  it("answers 503 for a sell while the price is unknown", async () => {
    price = { price: null, as_of: null };

    const res = await placing({ side: "sell", asset: "SOL", qty: "0.5" });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "price_unavailable" });
  });

  it("reads safekeeping fresh, bypassing the display cache", async () => {
    await get("/api/households");
    solana.balances.mockResolvedValueOnce({ sol: "1", tokens: { [USDC_MINT]: "5" } });

    const res = await placing({ side: "buy", asset: "SOL", usd: "10" });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "exceeds_safekeeping", message: "Only 5 USDC in the client wallet." });
    expect(solana.balances).toHaveBeenCalledTimes(2);
  });
});

describe("trade reads", () => {
  it("returns a running trade's progress", async () => {
    const household = await addHousehold();
    const { id } = (await (await post(`/api/households/${household}/trades`, { side: "buy", asset: "SOL", usd: "10" })).json()) as { id: string };

    const res = await get(`/api/trades/${id}`);

    expect(await res.json()).toEqual({
      id,
      household_id: household,
      side: "buy",
      asset: "SOL",
      status: "funding",
      usd: "10",
      steps: [
        { name: "move_in", state: "running", at: expect.any(String) },
        { name: "trade", state: "next", at: null },
        { name: "return", state: "next", at: null },
      ],
      placed_by: "Hana Sato",
      created_at: expect.any(String),
    });
  });

  it("returns a completed trade's result, fees per asset and explorer links", async () => {
    const household = await addHousehold();
    const { id } = (await (await post(`/api/households/${household}/trades`, { side: "buy", asset: "SOL", usd: "10" })).json()) as { id: string };
    const trade = trades.tradeStore.get(id)!;
    trades.tradeStore.update({
      ...trade,
      status: "complete",
      steps: trade.steps.map((s) => ({ ...s, state: "done", at: "2026-11-11T10:01:00Z" })) as typeof trade.steps,
      move_in: { ...trade.move_in, signature: "move-sig" },
      order: { order_id: "o-1", fee_asset: "USDC", detail: { fee: "0.02", executed_vwap: "182.2", tx_hash: "order-sig" } as OrderDetail },
      transfer: { transfer_id: "t-1", fee_asset: "SOL", detail: { fee: "0.0001", received: "0.0547", tx_hash: "back-sig", explorer_url: null } as TransferDetail },
    });

    const body = (await (await get(`/api/trades/${id}`)).json()) as { steps: { tx_url?: string }[]; result: unknown };

    expect(body.result).toEqual({
      spent: "10",
      received: "0.0547",
      avg_price: "182.2",
      fees: [
        { asset: "USDC", amount: "0.02" },
        { asset: "SOL", amount: "0.0001" },
      ],
    });
    expect(body.steps.map((s) => s.tx_url)).toEqual([
      "https://solscan.io/tx/move-sig",
      "https://solscan.io/tx/order-sig",
      "https://solscan.io/tx/back-sig",
    ]);
  });

  it("hides another organization's trade", async () => {
    const household = await addHousehold();
    const { id } = (await (await post(`/api/households/${household}/trades`, { side: "buy", asset: "SOL", usd: "10" })).json()) as { id: string };
    gateway.organizationId.mockResolvedValue("org-2");

    expect((await get(`/api/trades/${id}`)).status).toBe(404);
  });
});

describe("auth", () => {
  it.each([
    ["GET", "/api/me"],
    ["POST", "/api/logout"],
    ["GET", "/api/assets"],
    ["GET", "/api/households"],
    ["POST", "/api/households"],
    ["GET", "/api/households/hh-1"],
    ["POST", "/api/households/hh-1/finish-setup"],
    ["POST", "/api/households/hh-1/trades"],
    ["GET", "/api/trades/t-1"],
    ["POST", "/api/households/hh-1/withdrawals"],
    ["POST", "/api/households/hh-1/return-funds"],
    ["POST", "/api/households/hh-1/transfer-all"],
  ])("answers %s %s without a cookie with 401", async (method, path) => {
    const res = method === "GET" ? await get(path, "") : await post(path, {}, "");

    expect(res.status, path).toBe(401);
    expect(gateway.organizationId, path).not.toHaveBeenCalled();
  });

  it("answers an unknown API path with a JSON 404", async () => {
    const res = await get("/api/nope");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ type: "not_found" });
  });
});

describe("withdrawals", () => {
  let id: string;
  const withdraw = (body: unknown) => post(`/api/households/${id}/withdrawals`, body);
  const DESTINATION = SAFEKEEPING_ADDRESS;

  beforeEach(async () => {
    id = await addHousehold();
    solana.balances.mockResolvedValue({ sol: "1", tokens: { [USDC_MINT]: "100" } });
    solana.sendToken.mockImplementation(async ({ onSigned }) => {
      onSigned("sig-1");
      return "sig-1";
    });
    solana.sendSol.mockImplementation(async ({ onSigned }) => {
      onSigned("sig-2");
      return "sig-2";
    });
    solana.status.mockResolvedValue("confirmed");
  });

  it("sends a token to the address and answers with the signature and a Solscan link", async () => {
    const res = await withdraw({ asset: "USDC", amount: "25", to: DESTINATION });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: expect.any(String), status: "confirmed", signature: "sig-1", tx_url: "https://solscan.io/tx/sig-1" });
    expect(solana.sendToken.mock.calls[0]![0]).toMatchObject({ to: DESTINATION, mint: USDC_MINT, decimals: 6, amount: "25" });
    expect(solana.sendSol).not.toHaveBeenCalled();
  });

  it("sends SOL as a SOL transfer", async () => {
    const res = await withdraw({ asset: "SOL", amount: "0.5", to: DESTINATION });

    expect(res.status).toBe(200);
    expect(solana.sendSol.mock.calls[0]![0]).toMatchObject({ to: DESTINATION, amount: "0.5" });
    expect(solana.sendToken).not.toHaveBeenCalled();
  });

  it("reports a send that does not confirm in time as unconfirmed, with its link", async () => {
    solana.status.mockResolvedValue("unknown");

    const res = await withdraw({ asset: "USDC", amount: "25", to: DESTINATION });

    expect(await res.json()).toMatchObject({ status: "unconfirmed", signature: "sig-1" });
    expect(clockTime).toBeGreaterThanOrEqual(60_000);
  });

  it("answers 502 when the network refuses the send", async () => {
    solana.sendToken.mockRejectedValueOnce(new Error("insufficient funds for fee"));

    const res = await withdraw({ asset: "USDC", amount: "25", to: DESTINATION });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "send_failed", message: expect.stringContaining("insufficient funds for fee") });
  });

  it.each([
    ["an address that is not Solana's", { asset: "USDC", amount: "25", to: "0x3fA9b1C47e0D2a8F5E6c9B04d71A2F8e5b3Cc21E" }, "Enter a valid Solana address."],
    ["the client's own wallet", { asset: "USDC", amount: "25", to: "OWN" }, "That is this client's own wallet."],
  ])("refuses %s with a 400", async (name, body, message) => {
    const list = (await (await get("/api/households")).json()) as { households: { safekeeping: { address: string } }[] };
    const to = body.to === "OWN" ? list.households[0]!.safekeeping.address : body.to;

    const res = await withdraw({ ...body, to });

    expect(res.status, name).toBe(400);
    expect(await res.json(), name).toMatchObject({ message: `to: ${message}` });
    expect(solana.sendToken, name).not.toHaveBeenCalled();
  });

  it("refuses an asset that is not offered", async () => {
    const res = await withdraw({ asset: "DOGE", amount: "1", to: DESTINATION });

    expect(res.status).toBe(400);
  });

  it.each([
    ["more than the wallet holds", { asset: "USDC", amount: "100.01" }, "Only 100 USDC can be withdrawn."],
    ["more SOL than is left after the fee", { asset: "SOL", amount: "1" }, "Only 0.99999 SOL can be withdrawn."],
    ["a SOL amount too small to open an account", { asset: "SOL", amount: "0.0005" }, "Send at least 0.001 SOL."],
    ["more decimals than the token has", { asset: "USDC", amount: "1.1234567" }, "Use at most 6 decimal places."],
  ])("refuses %s with a 422", async (name, body, message) => {
    const res = await withdraw({ ...body, to: DESTINATION });

    expect(res.status, name).toBe(422);
    expect(await res.json(), name).toMatchObject({ code: "withdrawal_refused", message });
    expect(solana.sendToken, name).not.toHaveBeenCalled();
    expect(solana.sendSol, name).not.toHaveBeenCalled();
  });

  it("refuses a token send while the wallet holds too little SOL for fees", async () => {
    solana.balances.mockResolvedValue({ sol: "0.001", tokens: { [USDC_MINT]: "100" } });

    const res = await withdraw({ asset: "USDC", amount: "10", to: DESTINATION });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ message: "Keep about 0.003 SOL in the client wallet to pay network fees." });
  });

  it("refuses while a trade is in progress", async () => {
    trades.tradeStore.create(
      trades.newTrade({ id: "t-1", household_id: id, side: "buy", asset: "SOL", usd: "10", placed_by: "Hana Sato", now: "2026-11-11T10:00:00Z" }),
    );

    const res = await withdraw({ asset: "USDC", amount: "10", to: DESTINATION });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "wallet_busy" });
  });

  it("accepts one of two simultaneous withdrawals, and holds trades off while it runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    solana.sendToken.mockImplementation(async ({ onSigned }) => {
      onSigned("sig-1");
      await gate;
      return "sig-1";
    });

    const first = withdraw({ asset: "USDC", amount: "10", to: DESTINATION });
    await vi.waitFor(() => expect(solana.sendToken).toHaveBeenCalledTimes(1));
    const second = await withdraw({ asset: "USDC", amount: "10", to: DESTINATION });
    const trade = await post(`/api/households/${id}/trades`, { side: "buy", asset: "SOL", usd: "10" });
    release();

    expect((await first).status).toBe(200);
    expect(second.status).toBe(409);
    expect(trade.status).toBe(409);
    expect(await trade.json()).toMatchObject({ code: "wallet_busy" });
    expect(solana.sendToken).toHaveBeenCalledTimes(1);
  });
});

describe("returning a trading wallet's funds", () => {
  let id: string;
  const returnFunds = () => post(`/api/households/${id}/return-funds`, {});

  beforeEach(async () => {
    id = await addHousehold();
    gateway.balances.mockResolvedValue({ data: [balanceRow("JUP", "20"), balanceRow("USDC", "7")] });
    runner.returnToSafekeeping.mockImplementation(async (_h, asset, qty) => ({ received: qty, asset_id: asset.id }) as unknown as TransferDetail);
  });

  it("returns each asset the trading wallet holds, and reports what came back", async () => {
    const res = await returnFunds();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { symbol: "JUP", ok: true, received: "20" },
        { symbol: "USDC", ok: true, received: "7" },
      ],
    });
    expect(runner.returnToSafekeeping.mock.calls.map((c) => [c[1].symbol, c[2]])).toEqual([
      ["JUP", "20"],
      ["USDC", "7"],
    ]);
  });

  it("reports an asset the gateway refused and carries on with the rest", async () => {
    const { Stop } = await import("../runner.ts");
    runner.returnToSafekeeping.mockRejectedValueOnce(new Stop("The move back could not be prepared: below the minimum"));

    const body = (await (await returnFunds()).json()) as { results: unknown[] };

    expect(body.results).toEqual([
      { symbol: "JUP", ok: false, message: "The move back could not be prepared: below the minimum" },
      { symbol: "USDC", ok: true, received: "7" },
    ]);
  });

  it("has nothing to report when the trading wallet is empty", async () => {
    gateway.balances.mockResolvedValue({ data: [] });

    expect(await (await returnFunds()).json()).toEqual({ results: [] });
    expect(runner.returnToSafekeeping).not.toHaveBeenCalled();
  });

  it("refuses while a trade is in progress", async () => {
    trades.tradeStore.create(
      trades.newTrade({ id: "t-2", household_id: id, side: "buy", asset: "SOL", usd: "10", placed_by: "Hana Sato", now: "2026-11-11T10:00:00Z" }),
    );

    const res = await returnFunds();

    expect(res.status).toBe(409);
    expect(runner.returnToSafekeeping).not.toHaveBeenCalled();
  });

  it("refuses a client whose trading wallet was never created", async () => {
    gateway.createOrganizationUser.mockRejectedValueOnce(new TMError(500, { type: "internal", message: "boom" }));
    const pending = await addHousehold("Pending client");

    const res = await post(`/api/households/${pending}/return-funds`, {});

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "household_not_ready" });
  });
});

describe("transferring everything out", () => {
  let id: string;
  const DESTINATION = SAFEKEEPING_ADDRESS;
  const transferAll = (to = DESTINATION) => post(`/api/households/${id}/transfer-all`, { to });
  let sent: string[];

  beforeEach(async () => {
    id = await addHousehold();
    sent = [];
    solana.sendToken.mockImplementation(async ({ mint, onSigned }) => {
      sent.push(mint === USDC_MINT ? "USDC" : "JUP");
      onSigned(`sig-${sent.length}`);
      return `sig-${sent.length}`;
    });
    solana.sendSol.mockImplementation(async ({ onSigned }) => {
      sent.push("SOL");
      onSigned(`sig-${sent.length}`);
      return `sig-${sent.length}`;
    });
    solana.status.mockResolvedValue("confirmed");
    solana.balances
      .mockResolvedValueOnce({ sol: "0.1", tokens: { [USDC_MINT]: "50", [JUP_MINT]: "20" } })
      .mockResolvedValueOnce({ sol: "0.09", tokens: {} });
  });

  it("sends each token, then the SOL that is left after the fees, and reports every transaction", async () => {
    const res = await transferAll();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { symbol: "USDC", amount: "50", status: "confirmed", signature: "sig-1", tx_url: "https://solscan.io/tx/sig-1" },
        { symbol: "JUP", amount: "20", status: "confirmed", signature: "sig-2", tx_url: "https://solscan.io/tx/sig-2" },
        { symbol: "SOL", amount: "0.08999", status: "confirmed", signature: "sig-3", tx_url: "https://solscan.io/tx/sig-3" },
      ],
      stopped: false,
      left: [],
    });
    expect(sent).toEqual(["USDC", "JUP", "SOL"]);
  });

  it("stops at a send the network refuses, and leaves the rest in the wallet", async () => {
    solana.sendToken.mockReset();
    solana.sendToken
      .mockImplementationOnce(async ({ onSigned }) => {
        onSigned("sig-1");
        return "sig-1";
      })
      .mockRejectedValueOnce(new Error("insufficient funds for rent"));

    const body = (await (await transferAll()).json()) as { results: { symbol: string; status: string; message?: string }[]; stopped: boolean };

    expect(body.stopped).toBe(true);
    expect(body.results).toEqual([
      expect.objectContaining({ symbol: "USDC", status: "confirmed" }),
      { symbol: "JUP", amount: "20", status: "failed", message: "insufficient funds for rent" },
    ]);
    expect(solana.sendSol).not.toHaveBeenCalled();
  });

  it("stops at a send that does not confirm, so nothing else is sent over it", async () => {
    solana.status.mockResolvedValue("unknown");

    const body = (await (await transferAll()).json()) as { results: { symbol: string; status: string }[]; stopped: boolean };

    expect(body.stopped).toBe(true);
    expect(body.results).toEqual([expect.objectContaining({ symbol: "USDC", status: "unconfirmed" })]);
    expect(sent).toEqual(["USDC"]);
  });

  it("leaves SOL that is too small to send and says so", async () => {
    solana.balances.mockReset();
    solana.balances
      .mockResolvedValueOnce({ sol: "0.1", tokens: { [USDC_MINT]: "50" } })
      .mockResolvedValueOnce({ sol: "0.0005", tokens: {} });

    const body = (await (await transferAll()).json()) as { results: { symbol: string }[]; left: string[] };

    expect(body.results.map((r) => r.symbol)).toEqual(["USDC"]);
    expect(body.left).toEqual(["SOL"]);
    expect(solana.sendSol).not.toHaveBeenCalled();
  });

  it("refuses when the wallet holds too little SOL to pay for the token sends", async () => {
    solana.balances.mockReset();
    solana.balances.mockResolvedValueOnce({ sol: "0.004", tokens: { [USDC_MINT]: "50", [JUP_MINT]: "20" } });

    const res = await transferAll();

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ message: "Keep about 0.006 SOL in the client wallet to pay network fees." });
    expect(sent).toEqual([]);
  });

  it("refuses an empty wallet", async () => {
    solana.balances.mockReset();
    solana.balances.mockResolvedValueOnce({ sol: "0.00001", tokens: {} });

    const res = await transferAll();

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ message: "The client wallet holds nothing to transfer." });
  });

  it("refuses a bad address and a trade in progress", async () => {
    expect((await transferAll("not-an-address")).status).toBe(400);

    trades.tradeStore.create(
      trades.newTrade({ id: "t-3", household_id: id, side: "buy", asset: "SOL", usd: "10", placed_by: "Hana Sato", now: "2026-11-11T10:00:00Z" }),
    );
    const busy = await transferAll();

    expect(busy.status).toBe(409);
    expect(sent).toEqual([]);
  });
});
