import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Household } from "../server/households.ts";
import { balanceRow, SAFEKEEPING_ADDRESS, testCatalog, testHousehold, useTempDataDir } from "../server/testing.ts";
import type * as gatewayModule from "../server/tm/gateway.ts";
import type { TransferDetail } from "../server/tm/types.ts";
import type { Trade } from "../server/trades.ts";

type Gateway = typeof gatewayModule;

const HOUSEHOLD = testHousehold();

useTempDataDir("kumi-return-");

function transfer(id: string, assetId: string, status: string, qty: string): TransferDetail {
  return {
    id,
    status,
    venue: "defi",
    asset_id: assetId,
    asset_symbol: assetId === testCatalog.sol.id ? "SOL" : "USDC",
    chain: "solana",
    network: null,
    to: SAFEKEEPING_ADDRESS,
    qty,
    qty_unit: "base",
    sent: qty,
    fee: "0.01",
    received: qty,
    tx_hash: `${id}-tx`,
    explorer_url: null,
    payloads: [{ digest: "d", payload: `${id}-payload` }],
    created_at: "2026-11-11T10:00:00Z",
    updated_at: "2026-11-11T10:00:00Z",
  };
}

function fakeGateway() {
  const created = new Map<string, TransferDetail>();
  return {
    organizationId: vi.fn<Gateway["organizationId"]>(async () => "org-1"),
    balances: vi.fn<Gateway["balances"]>(async () => ({ data: [balanceRow("SOL", "0.0548"), balanceRow("USDC", "6.5")] })),
    createOrder: vi.fn<Gateway["createOrder"]>(),
    executeOrder: vi.fn<Gateway["executeOrder"]>(),
    getOrder: vi.fn<Gateway["getOrder"]>(),
    createTransfer: vi.fn<Gateway["createTransfer"]>(async (_u, t) => {
      const detail = transfer(`tr-${t.asset_id}`, t.asset_id, "awaiting_signature", t.qty);
      created.set(detail.id, detail);
      return detail;
    }),
    executeTransfer: vi.fn<Gateway["executeTransfer"]>(async (_u, id) => ({ ...created.get(id)!, status: "pending" })),
    getTransfer: vi.fn<Gateway["getTransfer"]>(async (_u, id) => ({ ...created.get(id)!, status: "completed" })),
  };
}

let gateway: ReturnType<typeof fakeGateway>;
let lines: string[];
let active: Trade | undefined;
let household: Household;
let returnFunds: typeof import("./return-funds.ts").returnFunds;
let createRunner: typeof import("../server/runner.ts").createRunner;
let TMError: typeof import("../server/tm/errors.ts").TMError;

beforeEach(async () => {
  ({ returnFunds } = await import("./return-funds.ts"));
  ({ createRunner } = await import("../server/runner.ts"));
  ({ TMError } = await import("../server/tm/errors.ts"));
  gateway = fakeGateway();
  lines = [];
  active = undefined;
  household = testHousehold();
});

function run(householdId = HOUSEHOLD.id) {
  let now = 0;
  const households = { get: (orgId: string, id: string) => (orgId === "org-1" && id === HOUSEHOLD.id ? household : undefined) };
  const runner = createRunner({
    gateway,
    solana: { balances: vi.fn(), sendToken: vi.fn(), sendSol: vi.fn(), status: vi.fn() },
    assets: testCatalog,
    trades: {} as never,
    households: { byId: () => household },
    clock: { now: () => now, sleep: async (ms) => void (now += ms) },
  });
  return returnFunds(householdId, {
    gateway,
    runner,
    assets: testCatalog,
    households,
    trades: { activeForHousehold: () => active },
    print: (line) => lines.push(line),
  });
}

describe("returnFunds", () => {
  it("moves the SOL and the USDC back to the client wallet", async () => {
    const code = await run();

    expect(code).toBe(0);
    expect(gateway.createTransfer.mock.calls.map((c) => c[1])).toEqual([
      { asset_id: testCatalog.sol.id, qty: "0.0548", to: SAFEKEEPING_ADDRESS },
      { asset_id: testCatalog.usdc.id, qty: "6.5", to: SAFEKEEPING_ADDRESS },
    ]);
    expect(gateway.executeTransfer).toHaveBeenCalledTimes(2);
    expect(lines).toEqual([
      "SOL: completed, 0.0548 SOL back in the client wallet (fee 0.01).",
      "JUP: nothing in the trading wallet.",
      "USDC: completed, 6.5 USDC back in the client wallet (fee 0.01).",
    ]);
  });

  it("refuses a household whose trading wallet was never created", async () => {
    household = { ...HOUSEHOLD, ready: false, trading_user_id: null, trading_address: null };

    const code = await run();

    expect(code).toBe(1);
    expect(lines).toEqual(["Ōtomo and Hana Fujiwara has no trading wallet yet, so there is nothing to return."]);
    expect(gateway.balances).not.toHaveBeenCalled();
  });

  it("refuses while a trade is running and writes nothing", async () => {
    active = { status: "buying" } as Trade;

    const code = await run();

    expect(code).toBe(1);
    expect(lines[0]).toContain("still running (buying)");
    expect(gateway.balances).not.toHaveBeenCalled();
    expect(gateway.createTransfer).not.toHaveBeenCalled();
    expect(gateway.executeTransfer).not.toHaveBeenCalled();
  });

  it("prints the gateway's message when a transfer is refused", async () => {
    gateway.balances.mockResolvedValueOnce({ data: [balanceRow("USDC", "2")] });
    gateway.createTransfer.mockRejectedValueOnce(
      new TMError(422, { type: "invalid_argument", message: "transfer amount is below minimum transfer size" }),
    );

    const code = await run();

    expect(code).toBe(1);
    expect(lines).toEqual([
      "SOL: nothing in the trading wallet.",
      "JUP: nothing in the trading wallet.",
      "USDC: The move back could not be prepared: transfer amount is below minimum transfer size",
    ]);
    expect(gateway.executeTransfer).not.toHaveBeenCalled();
  });

  it("answers an id outside this organization", async () => {
    const code = await run("someone-else");

    expect(code).toBe(1);
    expect(lines).toEqual(["No client someone-else in this organization."]);
  });
});
