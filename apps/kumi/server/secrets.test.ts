import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTempDataDir } from "./testing.ts";

const tempDir = useTempDataDir("kumi-secrets-");

describe("persistentSecret", () => {
  it("generates a secret once and returns the same one afterwards", async () => {
    const { persistentSecret } = await import("./secrets.ts");
    const generate = vi.fn(() => "abc123");

    const first = persistentSecret("wallet-signer-key", generate);
    const second = persistentSecret("wallet-signer-key", generate);

    expect(first).toMatchObject({ value: "abc123", created: true });
    expect(second).toMatchObject({ value: "abc123", created: false });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("writes the secret readable by its owner only, leaving nothing else behind", async () => {
    const { persistentSecret } = await import("./secrets.ts");

    const { file } = persistentSecret("wallet-signer-key", () => "abc123");

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(tempDir.dir)).toEqual(["wallet-signer-key"]);
  });

  it("keeps the secret another process wrote first, instead of replacing it", async () => {
    const { persistentSecret } = await import("./secrets.ts");

    const secret = persistentSecret("wallet-signer-key", () => {
      writeFileSync(join(tempDir.dir, "wallet-signer-key"), "written-first");
      return "written-second";
    });

    expect(secret).toMatchObject({ value: "written-first", created: false });
  });
});
