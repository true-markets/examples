import type { Confirmation } from "./solana/confirm.ts";
import { jsonFile } from "./store.ts";

type WithdrawalStatus = "sending" | Confirmation;

export interface Withdrawal {
  id: string;
  household_id: string;
  asset: string;
  amount: string;
  to: string;
  signature?: string;
  status: WithdrawalStatus;
  message?: string;
  created_at: string;
}

const file = jsonFile<{ withdrawals: Withdrawal[] }>("withdrawals.json", { withdrawals: [] });

export const withdrawalStore = {
  create(withdrawal: Withdrawal): void {
    file.write({ withdrawals: [...file.read().withdrawals, withdrawal] });
  },

  update(withdrawal: Withdrawal): void {
    file.write({ withdrawals: file.read().withdrawals.map((w) => (w.id === withdrawal.id ? withdrawal : w)) });
  },
};

// A client wallet sends one thing at a time, and a trade never starts under a send.
const sending = new Set<string>();

export const walletLock = {
  tryAcquire(householdId: string): boolean {
    if (sending.has(householdId)) return false;
    sending.add(householdId);
    return true;
  },
  release(householdId: string): void {
    sending.delete(householdId);
  },
  isHeld(householdId: string): boolean {
    return sending.has(householdId);
  },
};
