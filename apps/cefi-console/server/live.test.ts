import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveBackend } from "./live.ts";
import { claim, readApiKey, signWsRequest } from "./tm/auth.ts";

// A throwaway P-256 key in the same JSON shape app.truemarkets.co downloads.
function keyFile() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const dir = mkdtempSync(join(tmpdir(), "cefi-console-"));
  const file = join(dir, "key.json");
  writeFileSync(file, JSON.stringify({ key_id: "11112222-3333-4444-8555-666677778888", private_key: privateKey.export({ format: "jwk" }), algorithm: "ES256" }));
  return { file, publicKey };
}

function fakeJwt(claims: object) {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "ES256" })}.${part(claims)}.sig`;
}

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
}

describe("LiveBackend requests", () => {
  let calls: Call[];
  let respond: (call: Call) => unknown;

  beforeEach(() => {
    calls = [];
    respond = () => ({ data: [] });
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
      const call: Call = {
        method: init.method ?? "GET",
        url: new URL(String(input)),
        headers: Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const payload = call.url.pathname.endsWith("/api-key/token")
        ? { access_token: fakeJwt({ tm: { client_id: "555", organization_id: "org-1" } }), expires_in: new Date(Date.now() + 3_600_000).toISOString() }
        : respond(call);
      // A test can answer with { __status, __headers } to simulate an error such as a 429.
      const { __status, __headers, ...body } = (payload ?? {}) as { __status?: number; __headers?: Record<string, string> };
      return new Response(JSON.stringify(Array.isArray(payload) ? payload : body), {
        status: __status ?? (call.method === "DELETE" ? 202 : 200),
        headers: __headers,
      });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("signs the token challenge and sends CeFi calls with a bearer token and a fresh timestamp", async () => {
    const { file, publicKey } = keyFile();
    const live = new LiveBackend({ port: 0, mode: "live", environment: "production", keyFile: file });
    respond = () => ({ accepted: ["1", "2"] });
    expect(await live.cancelAll()).toEqual({ accepted: ["1", "2"], failed: [] });

    const [mint, cancel] = calls;
    expect(mint!.url.href).toBe("https://api.truemarkets.co/v1/auth/api-key/token");
    const { key_id, timestamp, signature } = mint!.body as { key_id: string; timestamp: number; signature: string };
    expect(verify("sha256", Buffer.from(`${key_id}.${timestamp}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))).toBe(true);

    expect(cancel!.method).toBe("DELETE");
    expect(cancel!.url.href).toBe("https://api.truex.co/v1/cefi/orders/all");
    expect(cancel!.headers.authorization).toMatch(/^Bearer /);
    expect(Math.abs(Number(cancel!.headers["x-truex-auth-timestamp"]) - Date.now() / 1000)).toBeLessThan(2);
  });

  it("builds a new order with the client id from the token", async () => {
    const { file } = keyFile();
    const live = new LiveBackend({ port: 0, mode: "live", environment: "uat", keyFile: file });
    respond = (c) =>
      c.url.pathname.endsWith("/instruments")
        ? { data: [{ id: "79060284917576679", status: "ACTIVE", info: { symbol: "TSLA-USDC" } }] }
        : { id: "8005237327190949926" };
    const res = await live.placeOrder({ symbol: "TSLA-USDC", side: "BUY", type: "LIMIT", tif: "GTC", qty: "0.01", price: "380", postOnly: true, externalId: "abc" });
    expect(res.orderId).toBe("8005237327190949926");
    const post = calls.find((c) => c.method === "POST" && c.url.pathname === "/v1/cefi/orders")!;
    expect(post.url.host).toBe("api.uat.truex.co");
    expect(post.body).toEqual({
      external_id: "abc",
      info: { client_id: "555", instrument_id: "79060284917576679", side: "BUY", type: "LIMIT", tif: "GTC", qty: "0.01", price: "380", exec_inst_flags: ["ALO"] },
    });
  });

  it("reads every page of a CeFi list, passing next_cursor back as timestamp", async () => {
    const { file } = keyFile();
    const live = new LiveBackend({ port: 0, mode: "live", environment: "production", keyFile: file });
    const inst = (id: string, symbol: string) => ({ id, status: "ACTIVE", info: { symbol } });
    respond = (c) =>
      c.url.searchParams.get("timestamp") === "1792502495502562617"
        ? { data: [inst("2", "NVDAC-USDC")], pagination: { size: 100, next_cursor: null } }
        : { data: [inst("1", "TSLA-USDC")], pagination: { size: 100, next_cursor: "1792502495502562617" } };
    expect((await live.instruments()).map((i) => i.symbol).sort()).toEqual(["NVDAC-USDC", "TSLA-USDC"]);
    const reads = calls.filter((c) => c.url.pathname === "/v1/cefi/instruments");
    expect(reads.map((c) => c.url.searchParams.get("size"))).toEqual(["100", "100"]);
  });

  it("shares one balance read between callers, and serves it stale through a 429", async () => {
    const { file } = keyFile();
    const live = new LiveBackend({ port: 0, mode: "live", environment: "production", keyFile: file });
    respond = () => ({ data: [], balances: [] });
    await Promise.all([live.balances(), live.balances(), live.balances()]);
    const reads = () => calls.filter((c) => c.url.pathname === "/v1/gateway/balances").length;
    expect(reads()).toBe(1);

    // Past the cache window, the gateway answers 429: the last good balances come back, and the
    // gateway is left alone until the window resets.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 9_000);
    respond = () => ({ __status: 429, __headers: { "x-ratelimit-reset": "20" } });
    await expect(live.balances()).resolves.toMatchObject({ wallet: [] });
    const before = calls.length;
    await expect(live.custody()).rejects.toMatchObject({ status: 429 });
    expect(calls.length).toBe(before);
    vi.useRealTimers();
  });

  it("follows a pending allocation by id instead of re-reading the lists", async () => {
    const { file } = keyFile();
    const live = new LiveBackend({ port: 0, mode: "live", environment: "production", keyFile: file });
    const alloc = (status: string) => ({ id: "a1", status, asset_id: "u1", asset_symbol: "USDC", amount: "10", created_at: "2026-11-18T00:00:00Z", updated_at: "x" });
    respond = (c) => (c.url.pathname.endsWith("/custody/allocations") ? { data: [alloc("crediting")] } : { data: [] });
    expect((await live.custody())[0]?.status).toBe("crediting");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3_500);
    respond = (c) => (c.url.pathname.endsWith("/custody/allocations/a1") ? alloc("completed") : { data: [] });
    expect((await live.custody())[0]?.status).toBe("completed");
    vi.useRealTimers();
    const custodyCalls = calls.filter((c) => c.url.pathname.includes("/custody/")).map((c) => c.url.pathname);
    expect(custodyCalls).toEqual(["/v1/gateway/custody/allocations", "/v1/gateway/custody/releases", "/v1/gateway/custody/allocations/a1"]);
  });

  it("shows an allocation done as soon as the exchange's transfer completes, before the gateway catches up", async () => {
    const { file } = keyFile();
    const live = new LiveBackend({ port: 0, mode: "live", environment: "production", keyFile: file });
    const alloc = { id: "a1", status: "crediting", asset_id: "u1", asset_symbol: "USDC", amount: "10", created_at: "2026-11-19T00:00:00Z", updated_at: "x", transfer: { id: "777", status: "PENDING" } };
    respond = (c) =>
      c.url.pathname.endsWith("/custody/allocations")
        ? { data: [alloc] }
        : c.url.pathname === "/v1/cefi/transfers"
          ? { data: [{ id: "777", status: "COMPLETED", updated_timestamp: "1795094078661538505" }] }
          : { data: [] };
    const [m] = await live.custody();
    expect(m).toMatchObject({ status: "crediting", exchange: { transferId: "777", status: "COMPLETED" } });
    expect(m!.exchange!.doneAt).toMatch(/^2026-/);
    // One CeFi read covers it; the gateway isn't asked again for the move yet.
    expect(calls.filter((c) => c.url.pathname === "/v1/cefi/transfers")).toHaveLength(1);
    expect(calls.some((c) => c.url.pathname.endsWith("/custody/allocations/a1"))).toBe(false);
  });

  it("allocates through the gateway custody endpoint", async () => {
    const { file } = keyFile();
    const live = new LiveBackend({ port: 0, mode: "live", environment: "production", keyFile: file });
    respond = () => ({ id: "a1", status: "crediting", asset_id: "u1", asset_symbol: "USDC", amount: "10", created_at: "x", updated_at: "x" });
    const move = await live.allocate("u1", "10");
    expect(move).toMatchObject({ id: "a1", kind: "allocation", status: "crediting", symbol: "USDC" });
    const post = calls.at(-1)!;
    expect(post.url.href).toBe("https://api.truemarkets.co/v1/gateway/custody/allocations");
    expect(post.body).toEqual({ asset_id: "u1", amount: "10" });
    expect(post.headers["x-truex-auth-timestamp"]).toBeUndefined();
  });
});

describe("WebSocket signing", () => {
  it("signs timestamp + TRUEXWS + key + path", () => {
    const { file, publicKey } = keyFile();
    const key = readApiKey(file);
    const signed = signWsRequest(key);
    const payload = `${signed.timestamp}TRUEXWS${key.keyId}/v1/cefi/market`;
    expect(verify("sha256", Buffer.from(payload), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signed.signature, "base64url"))).toBe(true);
    expect(signed.signature).not.toMatch(/[=+/]/);
  });

  it("reads claims at the top level or under tm", () => {
    expect(claim({ client_id: 7 }, "client_id")).toBe("7");
    expect(claim({ tm: { organization_id: "o" } }, "organization_id")).toBe("o");
    expect(claim({}, "client_id")).toBeUndefined();
  });
});

describe("account label", () => {
  it("uses the email in the token's sub claim", async () => {
    const { file } = keyFile();
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      const body = url.endsWith("/api-key/token")
        ? { access_token: fakeJwt({ sub: "trader@example.com", tm: { client_id: "555" } }), expires_in: new Date(Date.now() + 3_600_000).toISOString() }
        : { data: [{ id: "555", info: { mnemonic: "0123456789abcdef0123456789abcdef" } }] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const live = new LiveBackend({ port: 0, mode: "live", environment: "production", keyFile: file });
    expect((await live.session()).accountLabel).toBe("trader@example.com");
    vi.unstubAllGlobals();
  });
});

describe("DeFi orders through the gateway", () => {
  const catalog = {
    data: [
      { id: "cefi-nvdac", venue: "cefi", symbol: "NVDAC", chain: null, economic_asset_id: "econ-nvda", cefi_instrument: "NVDAC-USDC", order_types: ["market", "limit"] },
      { id: "defi-nvdac", venue: "defi", symbol: "NVDAC", chain: "base", economic_asset_id: "econ-nvda", order_types: ["market"] },
    ],
  };
  const instruments = { data: [{ id: "79053265670171223", status: "ACTIVE", info: { symbol: "NVDAC-USDC" } }] };

  function gateway(orderBody: object) {
    const calls: { url: URL; method: string; body?: any }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const payload = url.pathname.endsWith("/api-key/token")
        ? { access_token: fakeJwt({ tm: { client_id: "555" } }), expires_in: new Date(Date.now() + 3_600_000).toISOString() }
        : url.pathname === "/v1/cefi/instruments"
          ? instruments
          : url.pathname === "/v1/gateway/assets"
            ? catalog
            : url.pathname === "/v1/gateway/orders"
              ? orderBody
              : url.pathname.endsWith("/execute")
                ? { status: "complete" }
                : {};
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    return calls;
  }

  it("quotes on the DeFi listing, keeps the payloads, and executes with verifiable stamps", async () => {
    const { file, publicKey } = keyFile();
    const payloads = [{ payload: '{"type":"ACTIVITY_TYPE_SIGN_TRANSACTION","n":1}\n' }, { payload: '{"n":2}\n' }];
    const calls = gateway({ order_id: "ord-1", venue: "defi", payloads, quote: { base_asset: "NVDAC", quote_asset: "USDC", qty: "25", qty_out: "0.163", fee: "0.05", fee_asset: "USDC", issues: [] } });
    const live = new LiveBackend({ port: 0, mode: "live", environment: "production", keyFile: file });

    const q = await live.quoteDefi({ symbol: "NVDAC-USDC", side: "BUY", qty: "25" });
    expect(q).toMatchObject({ orderId: "ord-1", executable: true, assetIn: "USDC", assetOut: "NVDAC", qtyOut: "0.163", chain: "base" });
    const create = calls.find((c) => c.method === "POST" && c.url.pathname === "/v1/gateway/orders")!;
    expect(create.body).toEqual({ asset_id: "defi-nvdac", venue: "defi", type: "market", side: "buy", qty: "25", qty_unit: "quote" });

    await live.executeDefi("ord-1");
    const exec = calls.find((c) => c.url.pathname === "/v1/gateway/orders/ord-1/execute")!;
    expect(exec.body.auth_type).toBe("api_key");
    expect(exec.body.signatures).toHaveLength(2);
    exec.body.signatures.forEach((stamp: string, i: number) => {
      const s = JSON.parse(Buffer.from(stamp, "base64url").toString("utf8"));
      expect(s.scheme).toBe("SIGNATURE_SCHEME_TK_API_P256");
      expect(s.publicKey).toMatch(/^0[23][0-9a-f]{64}$/);
      // DER signature over the payload's exact bytes, trailing newline included.
      expect(verify("sha256", Buffer.from(payloads[i]!.payload), publicKey, Buffer.from(s.signature, "hex"))).toBe(true);
    });
    // A quote executes once.
    await expect(live.executeDefi("ord-1")).rejects.toMatchObject({ status: 404 });
    vi.unstubAllGlobals();
  });

  it("sizes a sell in the asset, and won't execute a quote the account can't fund or an old one", async () => {
    const { file } = keyFile();
    const calls = gateway({ order_id: "", venue: "defi", payloads: [], quote: { qty: "1", qty_out: "150", issues: ["Insufficient balance"] } });
    const live = new LiveBackend({ port: 0, mode: "live", environment: "production", keyFile: file });
    const q = await live.quoteDefi({ symbol: "NVDAC-USDC", side: "SELL", qty: "1" });
    expect(q).toMatchObject({ executable: false, issues: ["Insufficient balance"], assetIn: "NVDAC", assetOut: "USDC" });
    expect(calls.find((c) => c.url.pathname === "/v1/gateway/orders")!.body).toMatchObject({ side: "sell", qty_unit: "base" });
    vi.unstubAllGlobals();

    gateway({ order_id: "ord-2", venue: "defi", payloads: [{ payload: "x\n" }], quote: {} });
    const live2 = new LiveBackend({ port: 0, mode: "live", environment: "production", keyFile: file });
    await live2.quoteDefi({ symbol: "NVDAC-USDC", side: "BUY", qty: "10" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    await expect(live2.executeDefi("ord-2")).rejects.toMatchObject({ status: 409 });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
