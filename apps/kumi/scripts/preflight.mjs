// Checks the machine is ready to run Kumi and says what to do if not. Plain Node, so it runs before anything is installed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MIN_NODE = 22;

export function isPortFree(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.once("listening", () => probe.close(() => done(true)));
    probe.listen(port);
  });
}

function keyProblem(path) {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return `No API key at ${resolve(path)}. Move the key you downloaded from the developer console into .secrets/, or set TM_API_KEY_PATH to its location.`;
  let file = path;
  if (stat.isDirectory()) {
    const found = readdirSync(path).filter((name) => name.endsWith(".json"));
    if (found.length === 0) return `No API key in ${resolve(path)}. Move the key you downloaded from the developer console into it.`;
    if (found.length > 1) return `Found ${found.length} key files in ${resolve(path)} (${found.join(", ")}). Keep one, or set TM_API_KEY_PATH to the file to use.`;
    file = join(path, found[0]);
  }
  try {
    const key = JSON.parse(readFileSync(file, "utf8"));
    const jwk = key.private_key;
    if (typeof key.key_id === "string" && jwk?.kty === "EC" && jwk.crv === "P-256" && typeof jwk.d === "string") return null;
  } catch {
    // Falls through to the same message as a file with the wrong shape.
  }
  return `${resolve(file)} is not a True Markets API key file. Download it again from the developer console.`;
}

// Each check says what it looked at and, when it fails, what to do about it.
export async function runChecks({ cwd = process.cwd(), env = process.env, nodeVersion = process.versions.node, portFree = isPortFree } = {}) {
  const port = Number(env.PORT || 4848);
  const major = Number(nodeVersion.split(".")[0]);
  const key = keyProblem(resolve(cwd, env.TM_API_KEY_PATH || ".secrets"));
  let rpc = null;
  if (env.SOLANA_RPC_URL) {
    try {
      new URL(env.SOLANA_RPC_URL);
    } catch {
      rpc = "SOLANA_RPC_URL is not a valid URL. Fix it in .env, or remove it to use the public endpoint.";
    }
  }
  const free = await portFree(port);

  return [
    { ok: major >= MIN_NODE, label: `Node ${nodeVersion}`, fix: `Kumi needs Node ${MIN_NODE} or newer. Install it from https://nodejs.org or with a version manager.` },
    { ok: existsSync(join(cwd, "node_modules")), label: "Dependencies installed", fix: "Run npm install first." },
    { ok: key === null, label: "True Markets API key found", fix: key },
    { ok: rpc === null, label: "Solana RPC setting", fix: rpc },
    {
      ok: free,
      label: `Port ${port} is free`,
      fix: `Something is already using port ${port}. Is Kumi already running? Stop it, or set PORT in .env to another port.`,
    },
  ];
}

async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const checks = await runChecks();
  console.log("Checking your setup");
  for (const check of checks) console.log(`  ${check.ok ? "✓" : "✗"} ${check.label}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error("");
    for (const check of failed) console.error(`${check.label}: ${check.fix}`);
    process.exit(1);
  }
  console.log("");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
