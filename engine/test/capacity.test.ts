import { describe, expect, it } from "vitest";
import { safeOpenInterest } from "../src/capacity.js";
import { withConfig } from "../src/config.js";
import { monteCarlo } from "../src/montecarlo.js";
import { gap } from "../src/runs.js";
import { scaleOpenInterest } from "../src/scenario.js";
import type { StressPoint } from "../src/runs.js";
import { docsLong, syntheticSnapshot } from "./synthetic.js";

const cfg = withConfig({ capacity: { maxFactor: 20 } });

describe("gap", () => {
  it("skips the docs example straight past bankruptcy, so winners are owed the difference", () => {
    // Liquidations paused through a 15% fall: the mark lands at $85,000, under the $90,000 bankruptcy price.
    const r = gap(syntheticSnapshot({ positions: [docsLong], insuranceFund: 0 }), 0.15, cfg, { layerLimitUsd: 0 });
    const fill = r.events.find((e) => e.kind === "fill");
    expect(fill?.kind === "fill" && fill.path).toBe("gap");
    expect(r.totals.badDebt).toBeGreaterThan(4_500);
    expect(r.totals.tradersLose).toBeCloseTo(r.totals.badDebt, 6);
  });
});

describe("safe open interest", () => {
  const snap = syntheticSnapshot({ randomPositions: 300, usdPerLevel: 5_000, insuranceFund: 50_000 });

  it("is larger with the layer than with the fund alone", () => {
    const fund = safeOpenInterest(snap, 0.2, cfg, false);
    const both = safeOpenInterest(snap, 0.2, cfg, true);
    expect(both.factor).toBeGreaterThan(fund.factor);
  });

  it("really is safe at the answer and not safe just above it", () => {
    const c = safeOpenInterest(snap, 0.2, cfg, false);
    expect(c.atSearchLimit).toBe(false);
    const at = gap(scaleOpenInterest(snap, c.factor), 0.2, cfg, { totalsOnly: true, layerLimitUsd: 0 }).totals;
    const above = gap(scaleOpenInterest(snap, c.factor * 1.01), 0.2, cfg, { totalsOnly: true, layerLimitUsd: 0 }).totals;
    expect(at.tradersLose).toBeLessThanOrEqual(1e-6);
    expect(above.tradersLose).toBeGreaterThan(0);
  });
});

describe("Monte Carlo with liquidation pauses", () => {
  const zero = { badDebt: 0, fundPaid: 0, layerPaid: 0, tradersLose: 0, fundIncome: 0, liquidatedNotional: 0, liquidations: 0, bankruptcies: 0, fundStart: 1_000, fundEnd: 1_000, layerLimit: 10_000, spotStart: 1, spotEnd: 1, bookLow: 1, duration: 0, band: 0 as const };
  const quiet: StressPoint[] = [{ move: 0.4, totals: zero }];
  // Any gap of 10% or more leaves $5,000: past the $1,000 fund, inside the $10,000 layer.
  const gaps: StressPoint[] = [
    { move: 0.099, totals: zero },
    { move: 0.1, totals: { ...zero, badDebt: 5_000, fundPaid: 1_000, layerPaid: 4_000 } },
    { move: 0.4, totals: { ...zero, badDebt: 5_000, fundPaid: 1_000, layerPaid: 4_000 } },
  ];
  const c = withConfig({ monteCarlo: { years: 20_000, seed: 3, daysPerYear: 365 }, pause: { seconds: 60, perYear: 0.5, since: "2020-01-01" } });

  it("hits the layer as often as a Poisson year has at least one pause", () => {
    const mc = monteCarlo(quiet, [0.01], c, 1_000, 10_000, undefined, { curve: gaps, gaps: [0.2], source: "test" });
    expect(mc.pausesPerYear).toBe(0.5);
    expect(mc.pLayer).toBeGreaterThan(1 - Math.exp(-0.5) - 0.015);
    expect(mc.pLayer).toBeLessThan(1 - Math.exp(-0.5) + 0.015);
  });

  it("leaves pauses out when none are given", () => {
    const mc = monteCarlo(quiet, [0.01], c, 1_000, 10_000);
    expect(mc.pausesPerYear).toBe(0);
    expect(mc.pLayer).toBe(0);
  });
});
