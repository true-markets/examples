import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runChecks } from "./preflight.mjs";

const FIXTURE = "server/tm/testdata/truemarkets-org-api-key-test.json";

function project(options: { key?: boolean; modules?: boolean } = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), "kumi-preflight-"));
  mkdirSync(join(cwd, ".secrets"));
  if (options.key !== false) copyFileSync(FIXTURE, join(cwd, ".secrets", "key.json"));
  if (options.modules !== false) mkdirSync(join(cwd, "node_modules"));
  return cwd;
}

const free = async () => true;
const failing = (checks: { ok: boolean; label: string }[]) => checks.filter((c) => !c.ok).map((c) => c.label);

describe("preflight", () => {
  it("passes on a ready machine", async () => {
    const checks = await runChecks({ cwd: project(), env: {}, nodeVersion: "22.4.0", portFree: free });

    expect(failing(checks)).toEqual([]);
  });

  it("says what to do when there is no API key", async () => {
    const checks = await runChecks({ cwd: project({ key: false }), env: {}, nodeVersion: "22.4.0", portFree: free });

    expect(failing(checks)).toEqual(["True Markets API key found"]);
    expect(checks.find((c) => !c.ok)?.fix).toContain("Move the key you downloaded from the developer console into");
  });

  it("refuses a file that is not an API key", async () => {
    const cwd = project({ key: false });
    writeFileSync(join(cwd, ".secrets", "key.json"), JSON.stringify({ key_id: "k" }));

    const checks = await runChecks({ cwd, env: {}, nodeVersion: "22.4.0", portFree: free });

    expect(checks.find((c) => !c.ok)?.fix).toContain("is not a True Markets API key file");
  });

  it("asks for a choice when there are several keys", async () => {
    const cwd = project();
    copyFileSync(FIXTURE, join(cwd, ".secrets", "other.json"));

    const checks = await runChecks({ cwd, env: {}, nodeVersion: "22.4.0", portFree: free });

    expect(checks.find((c) => !c.ok)?.fix).toContain("Found 2 key files");
  });

  it("follows TM_API_KEY_PATH", async () => {
    const cwd = project({ key: false });
    const elsewhere = join(mkdtempSync(join(tmpdir(), "kumi-key-")), "mine.json");
    copyFileSync(FIXTURE, elsewhere);

    const checks = await runChecks({ cwd, env: { TM_API_KEY_PATH: elsewhere }, nodeVersion: "22.4.0", portFree: free });

    expect(failing(checks)).toEqual([]);
  });

  it("flags an old Node, missing dependencies, a busy port and a bad RPC URL together", async () => {
    const checks = await runChecks({
      cwd: project({ modules: false }),
      env: { PORT: "4900", SOLANA_RPC_URL: "not a url" },
      nodeVersion: "20.11.0",
      portFree: async (port) => port !== 4900,
    });

    expect(failing(checks)).toEqual(["Node 20.11.0", "Dependencies installed", "Solana RPC setting", "Port 4900 is free"]);
  });
});
