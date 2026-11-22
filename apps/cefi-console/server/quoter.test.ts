import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { quoterUrl } from "./env.ts";
import { QuoterClient } from "./quoter.ts";
import { SimBackend } from "./sim/backend.ts";
import { SimExchange } from "./sim/exchange.ts";

// A stand-in for cefi-quoter's management API that records what it was asked.
let server: Server;
let url = "";
const seen: { method: string; path: string; auth?: string; body: string }[] = [];
let params: Record<string, unknown> = { spreadBps: 10, quoteSize: "0.001" };

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, body });
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer tok") return res.writeHead(401).end(JSON.stringify({ error: "missing or wrong admin token" }));
    if (req.method === "PATCH") {
      const patch = JSON.parse(body) as Record<string, unknown>;
      if (Number(patch.spreadBps) < 0) return res.writeHead(400).end(JSON.stringify({ error: "spreadBps must be at least 0.1" }));
      params = { ...params, ...patch };
      return res.end(JSON.stringify({ params }));
    }
    if (req.url === "/api/status") return res.end(JSON.stringify({ books: [], available: [{ symbol: "BTC-USDC" }] }));
    if (req.url === "/api/books" && req.method === "POST") return res.end(JSON.stringify({ market: JSON.parse(body) }));
    if (req.url === "/api/books/BTC-USDC") return res.end(JSON.stringify({ state: "stopped", params }));
    if (req.url === "/api/books/BTC-USDC/start" || req.url === "/api/stop") return res.end(JSON.stringify({ enabled: req.url.endsWith("start") }));
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => server.close());

function app(quoter?: QuoterClient) {
  const backend = new SimBackend(new SimExchange(undefined, 1));
  backend.setStrategy(false);
  const a = createApp(backend, quoter);
  return async <T>(method: string, path: string, body?: unknown) => {
    const res = await a.request(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as T };
  };
}

describe("quoter passthrough", () => {
  it("says when no quoter is configured", async () => {
    const req = app();
    expect((await req<{ quoter: unknown }>("GET", "/api/session")).body.quoter).toBeNull();
    expect((await req("GET", "/api/quoter/status")).status).toBe(404);
  });

  it("passes status, books, params and start/stop through with the admin token", async () => {
    const req = app(new QuoterClient(url, "tok"));
    expect((await req<{ quoter: { url: string } }>("GET", "/api/session")).body.quoter).toEqual({ url });
    expect((await req<{ available: unknown[] }>("GET", "/api/quoter/status")).body.available).toHaveLength(1);
    const added = await req<{ market: { symbol: string; reference: string } }>("POST", "/api/quoter/books", { symbol: "BTC-USDC", reference: " BTC-USD " });
    expect(added.body.market).toEqual({ symbol: "BTC-USDC", reference: "BTC-USD" });
    expect((await req<{ state: string }>("GET", "/api/quoter/books/BTC-USDC")).body.state).toBe("stopped");
    const patched = await req<{ params: Record<string, unknown> }>("PATCH", "/api/quoter/books/BTC-USDC/params", { spreadBps: 25 });
    expect(patched.body.params.spreadBps).toBe(25);
    expect((await req<{ enabled: boolean }>("POST", "/api/quoter/books/BTC-USDC/start")).body.enabled).toBe(true);
    expect((await req<{ enabled: boolean }>("POST", "/api/quoter/stop")).body.enabled).toBe(false);
    expect(seen.every((s) => s.auth === "Bearer tok")).toBe(true);
    expect(seen.find((s) => s.method === "PATCH")).toMatchObject({ path: "/api/books/BTC-USDC/params", body: '{"spreadBps":25}' });
  });

  it("refuses a path that isn't a book symbol before calling the quoter", async () => {
    const before = seen.length;
    const res = await app(new QuoterClient(url, "tok"))<{ error: string }>("GET", "/api/quoter/books/..%2Fstatus");
    expect(res.status).toBe(400);
    expect(seen.length).toBe(before);
  });

  it("passes the quoter's validation errors through, and reports a wrong token as a quoter problem", async () => {
    const bad = await app(new QuoterClient(url, "tok"))<{ error: string }>("PATCH", "/api/quoter/books/BTC-USDC/params", { spreadBps: -1 });
    expect(bad).toEqual({ status: 400, body: expect.objectContaining({ error: "spreadBps must be at least 0.1" }) });
    const wrong = await app(new QuoterClient(url, "nope"))<{ error: string }>("GET", "/api/quoter/status");
    expect(wrong.status).toBe(502);
    expect(wrong.body.error).toMatch(/admin token/);
  });

  it("takes QUOTER_URL with or without http://", () => {
    expect(quoterUrl("127.0.0.1:4860")).toBe("http://127.0.0.1:4860");
    expect(quoterUrl(" http://127.0.0.1:4860/ ")).toBe("http://127.0.0.1:4860");
    expect(quoterUrl("https://quoter.internal")).toBe("https://quoter.internal");
    expect(quoterUrl("")).toBeUndefined();
  });

  it("explains an unreachable quoter", async () => {
    const res = await app(new QuoterClient("http://127.0.0.1:1"))<{ error: string }>("GET", "/api/quoter/status");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/isn't answering/);
  });
});
