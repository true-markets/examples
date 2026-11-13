import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env.ts";

export const DATA_DIR = env.DATA_DIR;

export interface PersistentSecret {
  value: string;
  file: string;
  created: boolean;
}

// Generated on first boot and kept in data/, so a disposable run needs no key setup.
// The file appears complete or not at all, and the first writer wins, so two processes starting together share one secret.
export function persistentSecret(name: string, generate: () => string): PersistentSecret {
  const file = join(DATA_DIR, name);
  if (existsSync(file)) return { value: readFileSync(file, "utf8").trim(), file, created: false };

  const value = generate();
  mkdirSync(DATA_DIR, { recursive: true });
  const staging = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(staging, value, { mode: 0o600 });
  try {
    linkSync(staging, file);
    return { value, file, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return { value: readFileSync(file, "utf8").trim(), file, created: false };
  } finally {
    unlinkSync(staging);
  }
}
