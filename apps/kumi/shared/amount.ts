const DECIMAL = /^-?\d+(\.\d+)?$/;

export function fractionDigits(decimal: string): number {
  return decimal.split(".")[1]?.length ?? 0;
}

export function toUnits(decimal: string, decimals: number): bigint {
  if (!DECIMAL.test(decimal)) throw new Error(`not a decimal number: ${decimal}`);
  if (fractionDigits(decimal) > decimals) throw new Error(`${decimal} has more than ${decimals} decimal places`);
  const negative = decimal.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? decimal.slice(1) : decimal).split(".");
  const units = BigInt(whole + frac.padEnd(decimals, "0"));
  return negative ? -units : units;
}

export function fromUnits(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const text = frac ? `${whole}.${frac}` : whole;
  return negative && text !== "0" ? `-${text}` : text;
}

export function floorDecimal(decimal: string, places: number): string {
  const scale = fractionDigits(decimal);
  if (scale <= places) return decimal;
  return fromUnits(toUnits(decimal, scale) / 10n ** BigInt(scale - places), places);
}

export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const scale = Math.max(fractionDigits(a), fractionDigits(b));
  const x = toUnits(a, scale);
  const y = toUnits(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function plusDecimal(a: string, b: string): string {
  const scale = Math.max(fractionDigits(a), fractionDigits(b));
  return fromUnits(toUnits(a, scale) + toUnits(b, scale), scale);
}

export function minusDecimal(a: string, b: string, decimals: number): string {
  return fromUnits(toUnits(a, decimals) - toUnits(b, decimals), decimals);
}
