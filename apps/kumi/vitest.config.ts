import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "web/**/*.test.ts", "shared/**/*.test.ts", "scripts/**/*.test.ts"],
    env: {
      TM_API_KEY_PATH: "server/tm/testdata",
      // Tests never touch the real advisors, households, keys or session secret in data/.
      DATA_DIR: mkdtempSync(join(tmpdir(), "kumi-test-")),
      SOLANA_RPC_URL: "http://127.0.0.1:1",
    },
  },
});
