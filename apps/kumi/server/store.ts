import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./secrets.ts";

export interface JsonFile<T> {
  read(): T;
  write(next: T): void;
}

// One process owns data/, so the file is read once and every write replaces it whole.
export function jsonFile<T>(name: string, empty: T): JsonFile<T> {
  const file = join(DATA_DIR, name);
  let value: T = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : empty;

  return {
    read: () => value,
    write(next) {
      mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2));
      renameSync(tmp, file);
      value = next;
    },
  };
}
