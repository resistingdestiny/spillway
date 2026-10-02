import { describe, expect, it } from "vitest";
import { withConfig } from "../src/config.js";
import { ledges } from "../src/ledges.js";
import { dailyMoves, lossAt, monteCarlo } from "../src/montecarlo.js";
import { priceLayer } from "../src/pricing.js";
import type { StressPoint } from "../src/runs.js";
import type { RunTotals } from "../src/types.js";
import { docsLong, syntheticSnapshot } from "./synthetic.js";

const totals = (badDebt: number, fund: number, limit: number): RunTotals => {
  const fundPaid = Math.min(fund, badDebt);
  const layerPaid = Math.min(limit, badDebt - fundPaid);
  return {
    badDebt,
    fundPaid,
    layerPaid,
    tradersLose: badDebt - fundPaid - layerPaid,
    fundIncome: 0,
    liquidatedNotional: 0,
    liquidations: 0,
    bankruptcies: 0,
    fundStart: fund,
    fundEnd: fund - fundPaid,
    layerLimit: limit,
    spotStart: 1,
    spotEnd: 1,
    bookLow: 1,
    duration: 0,
    band: 0,
  };
};

// A made-up curve: no loss below a 10% drop, then $1,000 of bad debt per extra 1%.
const FUND = 5_000;
const LIMIT = 10_000;
const curve: StressPoint[] = [0.05, 0.1, 0.2, 0.3, 0.4].map((move) => ({
  move,
  totals: totals(Math.max(0, (move - 0.1) * 100_000), FUND, LIMIT),
}));

describe("stress curve lookup", () => {
  it("interpolates between grid points", () => {
    expect(lossAt(curve, 0.15).badDebt).toBeCloseTo(5_000, 6);
    expect(lossAt(curve, 0.25).layerPaid).toBeCloseTo(10_000, 6);
  });
  it("is dry at no move and flat past the grid", () => {
    expect(lossAt(curve, 0).badDebt).toBe(0);
    expect(lossAt(curve, 0.9).badDebt).toBe(lossAt(curve, 0.4).badDebt);
  });
});

describe("Monte Carlo", () => {
  const cfg = withConfig({ monteCarlo: { years: 4_000, seed: 1, daysPerYear: 365 } });
  // One day in 1,000 falls 25%; the rest are quiet.
  const moves = Array.from({ length: 1_000 }, (_, i) => (i === 0 ? 0.25 : 0.01));

  it("matches the closed form for a one-in-a-thousand day", () => {
    const mc = monteCarlo(curve, moves, cfg, FUND, LIMIT);
    const expected = 1 - (1 - 1 / 1_000) ** 365;
    expect(mc.pFund).toBeGreaterThan(expected - 0.03);
    expect(mc.pFund).toBeLessThan(expected + 0.03);
    // A 25% day leaves $15,000: the fund's $5,000 and $10,000 of the layer.
    expect(mc.pLayer).toBeCloseTo(mc.pFund, 6);
    expect(mc.pTraders).toBeLessThan(mc.pLayer);
  });

  it("repeats exactly with the same seed", () => {
    expect(monteCarlo(curve, moves, cfg, FUND, LIMIT)).toEqual(monteCarlo(curve, moves, cfg, FUND, LIMIT));
  });

  it("never pays more from the layer in a year than its limit", () => {
    const allBad = Array.from({ length: 10 }, () => 0.4);
    const mc = monteCarlo(curve, allBad, cfg, FUND, LIMIT);
    expect(mc.expected.layerPaid).toBeCloseTo(LIMIT, 6);
    expect(mc.pTraders).toBe(1);
  });

  it("prices the layer from expected loss plus a load", () => {
    const mc = monteCarlo(curve, moves, cfg, FUND, LIMIT);
    const price = priceLayer(mc, cfg);
    expect(price.rate).toBeCloseTo(price.expectedLossRate * 2 + 0.04, 9);
    expect(price.annualPremium).toBeCloseTo(price.rate * LIMIT, 6);
  });
});

describe("daily moves", () => {
  it("drops the known bad print and measures open to low", () => {
    const day = (iso: string) => Date.parse(iso) / 1000;
    const m = dailyMoves({
      source: "test",
      rows: [
        [day("2017-04-14T00:00:00Z"), 100, 110, 90, 105],
        [day("2017-04-15T00:00:00Z"), 1173, 1191, 0.06, 1178],
      ],
    });
    expect(m.down).toEqual([0.09999999999999998]);
    expect(m.up[0]).toBeCloseTo(0.1, 9);
  });
});

describe("ledges", () => {
  it("puts the docs example on the ledge 6% below the mark", () => {
    const snap = syntheticSnapshot({ positions: [docsLong] });
    const l = ledges(snap, withConfig(), { bucket: 0.01 });
    expect(l).toHaveLength(1);
    expect(l[0]!.price).toBe(94_000);
    expect(l[0]!.distance).toBeCloseTo(0.06, 9);
    expect(l[0]!.notional).toBe(100_000);
  });
});
