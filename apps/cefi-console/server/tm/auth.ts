import { createPrivateKey, createPublicKey, sign, type KeyObject, type webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TmError } from "./errors.ts";

export interface ApiKey {
  keyId: string;
  privateKey: KeyObject;
}

// The JSON file app.truemarkets.co downloads: { key_id, private_key: <P-256 JWK>, algorithm: "ES256" }.
export function readApiKey(file: string): ApiKey {
  let parsed: { key_id?: unknown; private_key?: { kty?: unknown; crv?: unknown; d?: unknown } };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read the API key at ${resolve(file)}: ${(err as Error).message}`);
  }
  const { key_id: keyId, private_key: jwk } = parsed;
  if (typeof keyId !== "string" || jwk?.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string") {
    throw new Error(`${resolve(file)} is not a True Markets API key file (expected key_id and a P-256 private_key)`);
  }
  return { keyId, privateKey: createPrivateKey({ key: jwk as webcrypto.JsonWebKey, format: "jwk" }) };
}

// ES256 as True Markets wants it everywhere except wallet stamps: raw r || s, base64url, no padding.
export function signEs256(key: ApiKey, message: string): string {
  return sign("sha256", Buffer.from(message), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

// A wallet stamp for one unsigned payload from the gateway: sign the payload's exact UTF-8 bytes with
// ECDSA P-256 / SHA-256 (DER), then base64url the JSON { publicKey, signature, scheme }. The public
// key is the compressed one, as hex. The same API key that mints tokens is registered on the wallet.
export function stampPayload(key: ApiKey, payload: string): string {
  const signature = sign("sha256", Buffer.from(payload, "utf8"), key.privateKey).toString("hex");
  const json = JSON.stringify({ publicKey: compressedPublicKeyHex(key), signature, scheme: "SIGNATURE_SCHEME_TK_API_P256" });
  return Buffer.from(json).toString("base64url");
}

export function compressedPublicKeyHex(key: ApiKey): string {
  const jwk = createPublicKey(key.privateKey).export({ format: "jwk" });
  const x = Buffer.from(jwk.x!, "base64url");
  const y = Buffer.from(jwk.y!, "base64url");
  return Buffer.concat([Buffer.from([y[y.length - 1]! % 2 === 0 ? 2 : 3]), x]).toString("hex");
}

// Unix seconds, rounded down, made right before use: the exchange allows 15 s in the past and 1 s ahead.
export function unixSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

// The signed fields of a WebSocket SUBSCRIBE: sign `timestamp + "TRUEXWS" + key + path`.
export function signWsRequest(key: ApiKey, path = "/v1/cefi/market"): { timestamp: string; key: string; signature: string } {
  const timestamp = unixSeconds();
  return { timestamp, key: key.keyId, signature: signEs256(key, `${timestamp}TRUEXWS${key.keyId}${path}`) };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: string;
}

const REMINT_BEFORE_MS = 120_000;

// Mints an access token from the API key and mints again two minutes before it expires.
// Minting fresh works for both a personal key and an organization key, so refresh tokens are not used.
export class TokenSource {
  private cached: { token: string; expiresAt: number } | undefined;
  private inflight: Promise<string> | undefined;

  constructor(
    private readonly key: ApiKey,
    private readonly authBase: string,
  ) {}

  token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - Date.now() >= REMINT_BEFORE_MS) return Promise.resolve(this.cached.token);
    this.inflight ??= this.mint().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  async claims(): Promise<Record<string, unknown>> {
    const token = await this.token();
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  }

  private async mint(): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signEs256(this.key, `${this.key.keyId}.${timestamp}`);
    const res = await fetch(`${this.authBase}/api-key/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key_id: this.key.keyId, timestamp, signature }),
    });
    if (!res.ok) throw await TmError.from(res, "minting a token");
    const body = (await res.json()) as TokenResponse;
    const expiresAt = Date.parse(body.expires_in);
    this.cached = { token: body.access_token, expiresAt: Number.isNaN(expiresAt) ? Date.now() + 3_600_000 : expiresAt };
    return body.access_token;
  }
}

// Claims can sit at the top level or under `tm`, depending on the key type.
export function claim(claims: Record<string, unknown>, name: string): string | undefined {
  const nested = claims.tm as Record<string, unknown> | undefined;
  const v = claims[name] ?? nested?.[name];
  return v === undefined || v === null || v === "" ? undefined : String(v);
}
