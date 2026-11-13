import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organizationUser, TRADING_ADDRESS, useTempDataDir } from "./testing.ts";
import type * as gatewayModule from "./tm/gateway.ts";

type Gateway = typeof gatewayModule;
type Households = typeof import("./households.ts");

function fakeGateway() {
  return {
    organizationId: vi.fn<Gateway["organizationId"]>(async () => "org-1"),
    createOrganizationUser: vi.fn<Gateway["createOrganizationUser"]>(async (ref) => organizationUser(ref)),
  };
}

const tempDir = useTempDataDir("kumi-households-");
let households: Households;
let gateway: ReturnType<typeof fakeGateway>;
let TMError: typeof import("./tm/errors.ts").TMError;

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  households = await import("./households.ts");
  ({ TMError } = await import("./tm/errors.ts"));
  gateway = fakeGateway();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function keyFiles(): string[] {
  const dir = join(tempDir.dir, "safekeeping-keys");
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("addHousehold", () => {
  it("creates a ready household with its Solana trading wallet and a key file", async () => {
    const household = await households.addHousehold("Ōtomo and Hana Fujiwara", { gateway });

    expect(household).toMatchObject({
      org_id: "org-1",
      name: "Ōtomo and Hana Fujiwara",
      trading_user_id: `user-kumi_hh_${household.id}`,
      trading_address: TRADING_ADDRESS,
      ready: true,
    });
    const [ref] = gateway.createOrganizationUser.mock.calls[0]!;
    expect(ref).toMatch(/^kumi_hh_[A-Za-z0-9_-]{1,56}$/);
    expect(keyFiles()).toEqual([`${household.id}.json`]);
    expect(households.listForOrg("org-1")).toEqual([household]);
  });

  it("saves nothing at the organization's user limit and answers org_user_limit", async () => {
    gateway.createOrganizationUser.mockRejectedValueOnce(
      new TMError(422, {
        type: "failed_precondition",
        message: "organization has reached its user limit; contact support to raise it",
      }),
    );

    const err = await households.addHousehold("Sixth household", { gateway }).catch((e: unknown) => e);

    expect(err).toMatchObject({ status: 422, code: "org_user_limit", message: "This organization has reached its limit of 5 clients." });
    expect(households.listForOrg("org-1")).toEqual([]);
    expect(keyFiles()).toEqual([]);
  });

  it("keeps a household whose trading wallet failed, and finishes it later with the same key", async () => {
    gateway.createOrganizationUser.mockRejectedValueOnce(new TMError(500, { type: "internal", message: "boom" }));

    const pending = await households.addHousehold("Okafor household", { gateway });
    const keyBefore = readFileSync(join(tempDir.dir, "safekeeping-keys", `${pending.id}.json`), "utf8");
    const finished = await households.finishSetup(pending, { gateway });

    expect(pending).toMatchObject({ ready: false, trading_user_id: null, trading_address: null });
    expect(finished).toMatchObject({ id: pending.id, ready: true, trading_address: TRADING_ADDRESS });
    expect(finished.safekeeping_address).toBe(pending.safekeeping_address);
    expect(readFileSync(join(tempDir.dir, "safekeeping-keys", `${pending.id}.json`), "utf8")).toBe(keyBefore);
    const [first, second] = gateway.createOrganizationUser.mock.calls;
    expect(second).toEqual(first);
    expect(households.get("org-1", pending.id)).toEqual(finished);
  });

  it("treats a response without a Solana wallet as not ready", async () => {
    gateway.createOrganizationUser.mockResolvedValueOnce({ ...organizationUser("x"), wallets: [] });

    const household = await households.addHousehold("Patel household", { gateway });

    expect(household.ready).toBe(false);
  });
});

describe("listForOrg", () => {
  it("hides another organization's households", async () => {
    const mine = await households.addHousehold("Ōtomo and Hana Fujiwara", { gateway });
    gateway.organizationId.mockResolvedValueOnce("org-2");
    const theirs = await households.addHousehold("Ortiz household", { gateway });

    expect(households.listForOrg("org-1")).toEqual([mine]);
    expect(households.get("org-1", theirs.id)).toBeUndefined();
  });
});
