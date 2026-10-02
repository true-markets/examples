import { existsSync } from "node:fs";
import { z } from "zod";

if (existsSync(".env")) process.loadEnvFile(".env");

const schema = z.object({
  TM_API_URL: z.url().transform((url) => url.replace(/\/+$/, "")),
  TM_API_KEY_PATH: z.string().default(".secrets"),
  TM_TOKENS: z
    .string()
    .default(
      "SOL,JUP,JTO,PYTH,RAY,ORCA,DRIFT,W,RENDER,HNT,GRASS,BONK,WIF,PENGU,POPCAT,TRUMP,ETH@base,AERO@base,MORPHO@base,VIRTUAL@base",
    )
    .transform((list) =>
      list
        .split(",")
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  PORT: z.coerce.number().int().positive().default(4747),
  DATA_FILE: z.string().default("data/customers.json"),
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
