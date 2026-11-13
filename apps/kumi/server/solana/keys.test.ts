import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SOLANA_ADDRESS } from "../../shared/validation.ts";
import { useTempDataDir } from "../testing.ts";

const tempDir = useTempDataDir("kumi-keys-");

function keyFile(id: string): string {
  return join(tempDir.dir, "safekeeping-keys", `${id}.json`);
}

describe("safekeeping keys", () => {
  it("writes 64 bytes readable by its owner only", async () => {
    const { createSafekeepingKey } = await import("./keys.ts");

    const { address } = await createSafekeepingKey("hh-1");

    const bytes = JSON.parse(readFileSync(keyFile("hh-1"), "utf8")) as unknown[];
    expect(bytes).toHaveLength(64);
    expect(bytes.every((b) => Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255)).toBe(true);
    expect(statSync(keyFile("hh-1")).mode & 0o777).toBe(0o600);
    expect(address).toMatch(SOLANA_ADDRESS);
  });

  it("loads a signer for the same address", async () => {
    const { createSafekeepingKey, loadSafekeepingSigner } = await import("./keys.ts");
    const { address } = await createSafekeepingKey("hh-1");

    const signer = await loadSafekeepingSigner("hh-1");

    expect(signer.address).toBe(address);
  });

  it("refuses to replace an existing key and leaves it unchanged", async () => {
    const { createSafekeepingKey } = await import("./keys.ts");
    await createSafekeepingKey("hh-1");
    const before = readFileSync(keyFile("hh-1"), "utf8");

    await expect(createSafekeepingKey("hh-1")).rejects.toThrow("EEXIST");

    expect(readFileSync(keyFile("hh-1"), "utf8")).toBe(before);
  });
});
