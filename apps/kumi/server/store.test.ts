import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTempDataDir } from "./testing.ts";

const tempDir = useTempDataDir("kumi-store-", "nested");

describe("jsonFile", () => {
  it("writes atomically, leaving no .tmp behind, and re-reads the written value", async () => {
    const { jsonFile } = await import("./store.ts");
    jsonFile("things.json", { n: 0 }).write({ n: 7 });

    vi.resetModules();
    const reloaded = (await import("./store.ts")).jsonFile("things.json", { n: 0 });

    expect(reloaded.read()).toEqual({ n: 7 });
    expect(readdirSync(tempDir.dir)).toEqual(["things.json"]);
  });

  it("starts from the empty value when the file does not exist", async () => {
    const { jsonFile } = await import("./store.ts");

    expect(jsonFile("missing.json", { rows: [] }).read()).toEqual({ rows: [] });
    expect(existsSync(join(tempDir.dir, "missing.json"))).toBe(false);
  });
});
