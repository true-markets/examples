import { existsSync } from "node:fs";
import { z } from "zod";

if (existsSync(".env")) process.loadEnvFile(".env");

const schema = z.object({
  TM_API_KEY_PATH: z.string().default(".secrets"),
  SOLANA_RPC_URL: z.url().default("https://api.mainnet-beta.solana.com"),
  TM_TOKENS: z
    .string()
    .default("SOL,JUP,BONK,WIF,PYTH,RAY,JTO,RENDER,PENGU,TRUMP,W,ORCA,HNT,DRIFT")
    .transform((list) => [
      ...new Set(
        list
          .split(",")
          .map((symbol) => symbol.trim().toUpperCase())
          .filter(Boolean),
      ),
    ]),
  PORT: z.coerce.number().int().positive().default(4848),
  DATA_DIR: z.string().default("data"),
});

type Env = z.infer<typeof schema>;

function parseEnv(): Env {
  // A blank line in .env means "use the default", not "set to empty".
  const raw = Object.fromEntries(
    Object.keys(schema.shape).map((name) => [name, process.env[name] || undefined]),
  );
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`invalid environment:\n  ${problems.join("\n  ")}`);
  }
  return parsed.data;
}

export const env: Readonly<Env> = Object.freeze(parseEnv());
