import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// Reads .env next to package.json if there is one; real environment variables win.
try {
  process.loadEnvFile?.(".env");
} catch {
  // no .env, which is fine
}

export type Environment = "production" | "uat";

export interface Hosts {
  auth: string;
  gateway: string;
  cefi: string;
  ws: string;
}

export const HOSTS: Record<Environment, Hosts> = {
  production: {
    auth: "https://api.truemarkets.co/v1/auth",
    gateway: "https://api.truemarkets.co/v1/gateway",
    cefi: "https://api.truex.co/v1/cefi",
    ws: "wss://api.truemarkets.co/v1/cefi/market",
  },
  uat: {
    auth: "https://api.uat.truemarkets.co/v1/auth",
    gateway: "https://api.uat.truemarkets.co/v1/gateway",
    cefi: "https://api.uat.truex.co/v1/cefi",
    ws: "wss://api.uat.truemarkets.co/v1/cefi/market",
  },
};

export interface Config {
  port: number;
  mode: "live" | "demo";
  environment: Environment;
  keyFile?: string;
  // Overrides for what is normally read from the token's claims.
  clientId?: string;
  organizationId?: string;
  // Shown in the header instead of the client mnemonic, e.g. your email.
  accountLabel?: string;
}

export function loadConfig(e: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(e.API_PORT || 4850);
  const environment: Environment = e.TM_ENV === "uat" ? "uat" : "production";
  const keyPath = e.TM_API_KEY_PATH || ".secrets";
  const keyFile = findKeyFile(keyPath);

  let mode: Config["mode"];
  if (e.TM_MODE === "demo") mode = "demo";
  else if (e.TM_MODE === "live") {
    if (!keyFile) throw new Error(`TM_MODE=live needs an API key: put the key file from app.truemarkets.co in ${resolve(keyPath)} or set TM_API_KEY_PATH`);
    mode = "live";
  } else mode = keyFile ? "live" : "demo";

  return {
    port,
    mode,
    environment,
    keyFile,
    clientId: e.TM_CLIENT_ID || undefined,
    organizationId: e.TM_ORGANIZATION_ID || undefined,
    accountLabel: e.TM_ACCOUNT_LABEL || undefined,
  };
}

// Takes a key file, or a folder holding exactly one .json key file. Returns undefined when there is none.
function findKeyFile(path: string): string | undefined {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isDirectory()) return path;
  const found = readdirSync(path).filter((name) => name.endsWith(".json"));
  if (found.length > 1) {
    throw new Error(`found ${found.length} key files in ${resolve(path)} (${found.join(", ")}): set TM_API_KEY_PATH to the one to use`);
  }
  return found[0] ? join(path, found[0]) : undefined;
}
