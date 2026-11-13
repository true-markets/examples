import type { Clock } from "../clock.ts";
import type { SolanaClient } from "./client.ts";

const POLL_MS = 2_000;
const WINDOW_MS = 60_000;

export type Confirmation = "confirmed" | "failed" | "unconfirmed";

// Polls a signature until it lands, fails on chain, or the window closes. A failed read counts as "not yet".
export async function waitForConfirmation(solana: Pick<SolanaClient, "status">, signature: string, clock: Clock): Promise<Confirmation> {
  const deadline = clock.now() + WINDOW_MS;
  for (;;) {
    const status = await solana.status(signature).catch(() => "unknown" as const);
    if (status !== "unknown") return status;
    if (clock.now() >= deadline) return "unconfirmed";
    await clock.sleep(POLL_MS);
  }
}
