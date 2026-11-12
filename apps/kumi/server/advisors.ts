import { randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { jsonFile } from "./store.ts";

export interface Advisor {
  id: string;
  email: string;
  name: string;
  password: { salt: string; hash: string };
}

const DEMO_ADVISOR = { email: "hana.sato@kumi.example", password: "kumi-demo", name: "Hana Sato" };

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;

const scryptAsync = promisify(scrypt) as (password: Buffer, salt: Buffer, keylen: number, options: typeof SCRYPT) => Promise<Buffer>;

const file = jsonFile<{ advisors: Advisor[] }>("advisors.json", { advisors: [] });

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, SCRYPT);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function ensureDemoAdvisor(): void {
  if (file.read().advisors.length > 0) return;
  const salt = randomBytes(16);
  const advisor: Advisor = {
    id: randomUUID(),
    email: DEMO_ADVISOR.email,
    name: DEMO_ADVISOR.name,
    password: { salt: salt.toString("hex"), hash: hashPassword(DEMO_ADVISOR.password, salt).toString("hex") },
  };
  file.write({ advisors: [advisor] });
}

export function findByEmail(email: string): Advisor | undefined {
  const normalized = normalizeEmail(email);
  return file.read().advisors.find((a) => a.email === normalized);
}

export function findById(id: string): Advisor | undefined {
  return file.read().advisors.find((a) => a.id === id);
}

// Async so a login never stalls the runner's polling behind a synchronous hash.
export async function verifyPassword(advisor: Advisor, password: string): Promise<boolean> {
  const expected = Buffer.from(advisor.password.hash, "hex");
  const actual = await scryptAsync(Buffer.from(password), Buffer.from(advisor.password.salt, "hex"), KEY_LENGTH, SCRYPT);
  return timingSafeEqual(expected, actual);
}
