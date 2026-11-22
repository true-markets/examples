// The connection to a running cefi-quoter's management API (apps/cefi-quoter). The console server
// calls it on the browser's behalf, so the quoter's admin token, like your API key, never reaches
// the browser. Set QUOTER_URL (and QUOTER_TOKEN if the quoter has ADMIN_TOKEN) to turn it on.

import { TmError } from "./tm/errors.ts";

export class QuoterClient {
  constructor(
    readonly url: string,
    private readonly token?: string,
  ) {}

  // Every book at a glance: shared balances and connections, one line per book, books on offer.
  status(): Promise<unknown> {
    return this.call("GET", "/api/status");
  }

  // Fills this run, newest first, with edge at fill and mark-outs.
  trades(limit = 500): Promise<unknown> {
    return this.call("GET", `/api/trades?limit=${Math.max(1, Math.min(5000, Math.floor(limit)))}`);
  }

  book(symbol: string): Promise<unknown> {
    return this.call("GET", `/api/books/${encodeURIComponent(symbol)}`);
  }

  addBook(symbol: string, reference?: string): Promise<unknown> {
    return this.call("POST", "/api/books", { symbol, reference: reference || undefined });
  }

  removeBook(symbol: string): Promise<unknown> {
    return this.call("DELETE", `/api/books/${encodeURIComponent(symbol)}`);
  }

  params(symbol: string): Promise<unknown> {
    return this.call("GET", `/api/books/${encodeURIComponent(symbol)}/params`);
  }

  updateParams(symbol: string, patch: Record<string, unknown>): Promise<unknown> {
    return this.call("PATCH", `/api/books/${encodeURIComponent(symbol)}/params`, patch);
  }

  // Start or stop one book, or every book when symbol is left out.
  control(action: "start" | "stop", symbol?: string): Promise<unknown> {
    return this.call("POST", symbol ? `/api/books/${encodeURIComponent(symbol)}/${action}` : `/api/${action}`);
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(this.url + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      throw new TmError(`the quoter at ${this.url} isn't answering (${(err as Error).message}). Is cefi-quoter running?`, 502);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    // The quoter's own 400s (a bad parameter) pass through as they are, so the UI can show why.
    if (!res.ok) throw new TmError(data.error ?? `quoter ${method} ${path} failed (${res.status})`, res.status === 401 ? 502 : res.status);
    return data;
  }
}
