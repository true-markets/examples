import { setTimeout as sleep } from "node:timers/promises";

// Time as a dependency, so tests can run a two-minute wait in no time.
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => sleep(ms) };
