// The CeFi exchange's minimum increments, which depend on the price: the tick (price step), the lot
// (quantity step) and the minimum notional of an order. The exchange doesn't publish these in its
// API, so they are kept here. Buckets run from the highest price down; a price belongs to the first
// bucket whose lower bound it reaches.

export interface Increments {
  // Price must be a multiple of this.
  tick: number;
  // Quantity must be a multiple of this.
  lot: number;
  // qty × price must be at least this, in the quote asset.
  minNotional: number;
}

interface Bucket extends Increments {
  minPrice: number;
}

const BUCKETS: Bucket[] = [
  { minPrice: 500_000, tick: 1, lot: 0.000001, minNotional: 1 },
  { minPrice: 100_000, tick: 0.5, lot: 0.00001, minNotional: 1 },
  { minPrice: 10_000, tick: 0.1, lot: 0.0001, minNotional: 1 },
  { minPrice: 1_000, tick: 0.01, lot: 0.001, minNotional: 1 },
  // The exchange's table gives a 0.01 lot here, but the live exchange accepts 0.001 (most open
  // orders in this range use it), so this follows the live behavior.
  { minPrice: 10, tick: 0.001, lot: 0.001, minNotional: 1 },
  { minPrice: 0.1, tick: 0.0001, lot: 1, minNotional: 1 },
  { minPrice: 0.001, tick: 0.000001, lot: 100, minNotional: 1 },
  { minPrice: 0.00001, tick: 0.00000001, lot: 10_000, minNotional: 1 },
  { minPrice: 0, tick: 0.0000000001, lot: 1_000_000, minNotional: 1 },
];

export function incrementsFor(price: number): Increments {
  const b = BUCKETS.find((x) => price >= x.minPrice) ?? BUCKETS[BUCKETS.length - 1]!;
  return { tick: b.tick, lot: b.lot, minNotional: b.minNotional };
}

// Decimal places a step needs: 0.001 → 3, 1 → 0, 100 → 0.
export function stepDecimals(step: number): number {
  if (step >= 1) return 0;
  return Math.max(0, Math.round(-Math.log10(step)));
}

// Whether a value is a whole number of steps, allowing for float noise.
export function isMultiple(value: number, step: number): boolean {
  const n = value / step;
  return Math.abs(n - Math.round(n)) < 1e-6;
}

// Rounds down to a whole number of steps, as a decimal string.
export function floorToStep(value: number, step: number): string {
  const n = Math.floor(value / step + 1e-9);
  return (n * step).toFixed(stepDecimals(step));
}
