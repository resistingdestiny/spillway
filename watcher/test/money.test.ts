import { describe, expect, it } from "vitest";
import { formatUnits, toDollars, toUnits } from "../src/money.js";

describe("toUnits", () => {
  it("converts whole and 6-decimal amounts exactly", () => {
    expect(toUnits(0)).toBe(0n);
    expect(toUnits(1)).toBe(1_000_000n);
    expect(toUnits(250_000)).toBe(250_000_000_000n);
    expect(toUnits(178387.845452)).toBe(178_387_845_452n);
    expect(toUnits(0.000001)).toBe(1n);
  });

  it("rounds half up on the 7th decimal", () => {
    expect(toUnits(0.0000005)).toBe(1n);
    expect(toUnits(0.00000049)).toBe(0n);
    expect(toUnits(0.0000014999)).toBe(1n);
    expect(toUnits(0.0000015)).toBe(2n);
    expect(toUnits(1.0000005)).toBe(1_000_001n);
    expect(toUnits(12.3456784999)).toBe(12_345_678n);
    expect(toUnits(12.3456785)).toBe(12_345_679n);
  });

  it("rounds the decimal the engine prints, not the binary float", () => {
    // 0.0001245 * 1e6 is 124.49999999999999 in floating point.
    expect(Math.round(0.0001245 * 1e6)).toBe(124);
    expect(toUnits(0.0001245)).toBe(125n);
    // toFixed works on the exact binary value, which is just below the half.
    expect((0.0000035).toFixed(6)).toBe("0.000003");
    expect(toUnits(0.0000035)).toBe(4n);
  });

  it("carries a round-up into the whole dollars", () => {
    expect(toUnits(0.9999995)).toBe(1_000_000n);
    expect(toUnits(123456.9999995)).toBe(123_457_000_000n);
  });

  it("handles exponent notation", () => {
    expect(String(1.5e-7)).toBe("1.5e-7");
    expect(toUnits(1.5e-7)).toBe(0n);
    expect(toUnits(5e-7)).toBe(1n);
    expect(toUnits(5.5e-6)).toBe(6n);
    expect(String(1e21)).toBe("1e+21");
    expect(toUnits(1e21)).toBe(10n ** 27n);
  });

  it("keeps float noise below the 7th decimal out of the result", () => {
    expect(toUnits(0.1 + 0.2)).toBe(300_000n);
    expect(toUnits(1002.11037237319)).toBe(1_002_110_372n);
  });

  it("rejects negative and non-finite amounts", () => {
    expect(() => toUnits(-1)).toThrow(RangeError);
    expect(() => toUnits(Number.NaN)).toThrow(RangeError);
    expect(() => toUnits(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("is never more than half a unit away from the input", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 10_000; i++) {
      const x = rand() * 10 ** Math.floor(rand() * 7);
      const err = Math.abs(toDollars(toUnits(x)) - x);
      expect(err).toBeLessThanOrEqual(0.5e-6 + 1e-9);
    }
  });
});

describe("formatUnits", () => {
  it("prints six decimals and a sign", () => {
    expect(formatUnits(0n)).toBe("0.000000");
    expect(formatUnits(178_387_845_452n)).toBe("178387.845452");
    expect(formatUnits(-3n)).toBe("-0.000003");
  });
});
