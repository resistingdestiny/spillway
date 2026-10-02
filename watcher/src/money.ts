// Dollars (engine floats) to tUSD base units (6 decimals) and back.
//
// Rounding rule, applied once per engine event:
//   1. Take the shortest decimal that round-trips the engine's number. This is what
//      JSON.stringify prints, so anyone can redo the conversion from a report by hand.
//   2. Round it half up to 6 decimals: a 7th decimal digit of 5 or more adds one unit.
//
// Working on the decimal string, not on x * 1e6, keeps the rule exact. For example
// 0.0001245 rounds to 125 units here, while Math.round(0.0001245 * 1e6) gives 124
// because the product comes out as 124.49999999999999. Likewise (0.0000035).toFixed(6)
// gives "0.000003". Each event is off by at most half a unit ($0.0000005).

export const DECIMALS = 6;
export const UNIT = 1_000_000n;

export function toUnits(dollars: number): bigint {
  if (!Number.isFinite(dollars)) throw new RangeError(`not a finite dollar amount: ${dollars}`);
  if (dollars < 0) throw new RangeError(`negative dollar amount: ${dollars}`);

  // "12.3456785", "1.5e-7" or "1e+21"
  const [mantissa = "0", expPart] = String(dollars).split("e");
  const exp = expPart === undefined ? 0 : Number(expPart);
  const [intPart = "0", fracPart = ""] = mantissa.split(".");
  let digits = intPart + fracPart;
  let point = intPart.length + exp;
  if (point < 0) {
    digits = "0".repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits = digits + "0".repeat(point - digits.length);

  const whole = digits.slice(0, point) || "0";
  const frac = digits.slice(point);
  let units = BigInt(whole) * UNIT + BigInt(frac.slice(0, DECIMALS).padEnd(DECIMALS, "0"));
  if ((frac[DECIMALS] ?? "0") >= "5") units += 1n;
  return units;
}

/** Units to dollars as a number. Exact for any amount below about $9 billion. */
export function toDollars(units: bigint): number {
  return Number(units) / 1e6;
}

/** Units as a fixed 6-decimal dollar string, e.g. "-0.000003" or "178387.845452". */
export function formatUnits(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  return `${neg ? "-" : ""}${abs / UNIT}.${(abs % UNIT).toString().padStart(DECIMALS, "0")}`;
}

/** A dollar float as a fixed 6-decimal string, for tables. */
export function formatDollars(dollars: number): string {
  return dollars.toFixed(DECIMALS);
}
