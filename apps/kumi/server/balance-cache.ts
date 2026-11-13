const TTL_MS = 10_000;

type BalanceCache<T> = (householdId: string, load: () => Promise<T>) => Promise<T>;

// Display reads share one load per household per TTL, failures included, so browser polling never multiplies upstream calls.
export function createBalanceCache<T>(ttlMs = TTL_MS): BalanceCache<T> {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return (householdId, load) => {
    const hit = entries.get(householdId);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = load();
    value.catch(() => {});
    entries.set(householdId, { at: Date.now(), value });
    return value;
  };
}
