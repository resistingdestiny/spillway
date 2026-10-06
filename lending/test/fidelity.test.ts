import { describe, expect, it } from "vitest";
import { checkHealthFactors, reconcileTotals } from "../src/fidelity.js";
import { int } from "../src/snapshot.js";
import { monadBook } from "./fixture.js";

describe("loader", () => {
  it("reads amounts exactly whether the API sent a number or a string", () => {
    expect(int("86212725987872664977408")).toBe(86212725987872664977408n);
    expect(int(1012371991373)).toBe(1012371991373n);
    expect(int(null)).toBe(0n);
    expect(() => int(2 ** 60)).toThrow();
  });

  it("loads every market and position in the 6 October snapshot", () => {
    const book = monadBook();
    expect(book.markets).toHaveLength(130);
    expect(book.positions).toHaveLength(1109);
    expect(book.blocks.from.number).toBe(111058609);
    expect(book.blocks.to.number).toBe(111058632);
  });

  it("scales the oracle price by 1e36 and the two tokens' decimals", () => {
    const book = monadBook();
    // wstETH/WETH, both 18 decimals: about 1.2457 WETH per wstETH.
    const wsteth = book.markets.find((m) => m.collateral?.symbol === "wstETH" && m.loan.symbol === "WETH");
    expect(wsteth?.price).toBeCloseTo(1.2457, 4);
    // strUSD (18 decimals) against AUSD (6 decimals): about 1.029 AUSD per strUSD.
    const strusd = book.markets.find((m) => m.collateral?.symbol === "strUSD" && m.loan.symbol === "AUSD");
    expect(strusd?.price).toBeCloseTo(1.0288, 4);
  });
});

describe("health factor against the Morpho API on live data", () => {
  const { rows, markets, missing } = checkHealthFactors(monadBook());

  it("covers every borrower", () => {
    expect(missing).toBe(0);
    expect(rows).toHaveLength(447);
  });

  it("matches the API within 0.1% for every borrower", () => {
    for (const r of rows) expect(Math.abs(r.gap)).toBeLessThan(1e-3);
  });

  it("matches exactly, to rounding, for most borrowers", () => {
    const exact = rows.filter((r) => Math.abs(r.gap) < 1e-12).length;
    expect(exact / rows.length).toBeGreaterThan(0.5);
  });

  it("differs, where it differs, by one offset per market: the API read the oracle at another moment", () => {
    // A wrong formula would give gaps that vary with each position's size or leverage. A price read a
    // few seconds apart (PT oracles drift every second) moves every borrower in the market alike.
    for (const m of markets) expect(m.spread).toBeLessThan(1e-9);
  });
});

describe("market totals against the positions", () => {
  it("reconciles supply and borrow, assets and shares, within 1% in every market", () => {
    const checks = reconcileTotals(monadBook());
    expect(checks.length).toBe(130 * 5);
    const off = checks.filter((c) => c.field !== "collateral" && c.gap > 0.01);
    expect(off).toEqual([]);
  });

  it("reconciles collateral within 1% too", () => {
    const off = reconcileTotals(monadBook()).filter((c) => c.field === "collateral" && c.gap > 0.01);
    expect(off).toEqual([]);
  });
});
