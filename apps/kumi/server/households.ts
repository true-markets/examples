import { randomUUID } from "node:crypto";
import { ApiError } from "./http.ts";
import { createSafekeepingKey } from "./solana/keys.ts";
import { jsonFile } from "./store.ts";
import { errorMessage, TMError } from "./tm/errors.ts";
import type * as gateway from "./tm/gateway.ts";
import { signerPublicKeyCompressedHex } from "./tm/stamp.ts";

export interface Household {
  id: string;
  org_id: string;
  name: string;
  created_at: string;
  safekeeping_address: string;
  trading_user_id: string | null;
  trading_address: string | null;
  ready: boolean;
}

export interface SetupDeps {
  gateway: Pick<typeof gateway, "organizationId" | "createOrganizationUser">;
}

const file = jsonFile<{ households: Household[] }>("households.json", { households: [] });

const orgUserLimit = () =>
  new ApiError(422, "failed_precondition", "This organization has reached its limit of 5 clients.", {
    code: "org_user_limit",
  });

export function listForOrg(orgId: string): Household[] {
  return file.read().households.filter((h) => h.org_id === orgId);
}

export function get(orgId: string, id: string): Household | undefined {
  return listForOrg(orgId).find((h) => h.id === id);
}

export function byId(id: string): Household | undefined {
  return file.read().households.find((h) => h.id === id);
}

function save(household: Household): Household {
  const all = file.read().households;
  const next = all.some((h) => h.id === household.id)
    ? all.map((h) => (h.id === household.id ? household : h))
    : [...all, household];
  file.write({ households: next });
  return household;
}

function isUserLimit(err: unknown): boolean {
  return err instanceof TMError && err.status === 422 && err.body.type === "failed_precondition";
}

// Idempotent on external_ref_id, and a repeat repairs missing wallets, so a failed setup is finished by sending it again.
async function seatTradingUser(householdId: string, deps: SetupDeps): Promise<{ user_id: string; address: string } | undefined> {
  try {
    const user = await deps.gateway.createOrganizationUser(`kumi_hh_${householdId}`, signerPublicKeyCompressedHex);
    const wallet = user.wallets.find((w) => w.chain_family.toLowerCase() === "solana");
    if (wallet) return { user_id: user.user_id, address: wallet.address };
    console.warn(`trading user for household ${householdId} came back without a Solana wallet`);
  } catch (err) {
    if (isUserLimit(err)) throw orgUserLimit();
    console.warn(`creating the trading user for household ${householdId} failed: ${errorMessage(err)}`);
  }
  return undefined;
}

export async function addHousehold(name: string, deps: SetupDeps): Promise<Household> {
  const orgId = await deps.gateway.organizationId();
  const id = randomUUID();
  const seated = await seatTradingUser(id, deps);
  const { address } = await createSafekeepingKey(id);
  return save({
    id,
    org_id: orgId,
    name,
    created_at: new Date().toISOString(),
    safekeeping_address: address,
    trading_user_id: seated?.user_id ?? null,
    trading_address: seated?.address ?? null,
    ready: seated !== undefined,
  });
}

export async function finishSetup(household: Household, deps: SetupDeps): Promise<Household> {
  if (household.ready) return household;
  const seated = await seatTradingUser(household.id, deps);
  if (!seated) return household;
  return save({ ...household, trading_user_id: seated.user_id, trading_address: seated.address, ready: true });
}
