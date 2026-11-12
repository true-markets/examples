import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  type KeyPairSigner,
} from "@solana/kit";
import { DATA_DIR } from "../secrets.ts";

const KEYS_DIR = join(DATA_DIR, "safekeeping-keys");

function keyFile(householdId: string): string {
  return join(KEYS_DIR, `${householdId}.json`);
}

// Solana CLI keypair format: the 32-byte seed then the 32-byte public key. "wx" refuses to replace a key that may hold funds.
export async function createSafekeepingKey(householdId: string): Promise<{ address: string }> {
  const seed = randomBytes(32);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const bytes = [...seed, ...getAddressEncoder().encode(signer.address)];
  mkdirSync(KEYS_DIR, { recursive: true });
  writeFileSync(keyFile(householdId), JSON.stringify(bytes), { mode: 0o600, flag: "wx" });
  return { address: signer.address };
}

export function loadSafekeepingSigner(householdId: string): Promise<KeyPairSigner> {
  const bytes = JSON.parse(readFileSync(keyFile(householdId), "utf8")) as number[];
  return createKeyPairSignerFromBytes(Uint8Array.from(bytes));
}
