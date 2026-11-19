import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "web/**/*.test.ts", "shared/**/*.test.ts"],
    // Tests run against the in-process simulator and never reach True Markets.
    env: { TM_MODE: "demo" },
  },
});
