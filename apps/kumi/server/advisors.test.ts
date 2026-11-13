import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTempDataDir } from "./testing.ts";

const tempDir = useTempDataDir("kumi-advisors-");

describe("ensureDemoAdvisor", () => {
  it("creates exactly one advisor, however often it runs", async () => {
    const advisors = await import("./advisors.ts");

    advisors.ensureDemoAdvisor();
    advisors.ensureDemoAdvisor();
    vi.resetModules();
    const reloaded = await import("./advisors.ts");
    reloaded.ensureDemoAdvisor();

    expect(JSON.parse(readFileSync(join(tempDir.dir, "advisors.json"), "utf8")).advisors).toHaveLength(1);
    expect(reloaded.findByEmail("hana.sato@kumi.example")).toMatchObject({ name: "Hana Sato" });
  });

  it("never writes the plaintext password", async () => {
    (await import("./advisors.ts")).ensureDemoAdvisor();

    expect(readFileSync(join(tempDir.dir, "advisors.json"), "utf8")).not.toContain("kumi-demo");
  });
});
