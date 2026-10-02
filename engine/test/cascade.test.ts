import { describe, expect, it } from "vitest";
import { withConfig } from "../src/config.js";
import { stress, stressCurve, smallestMoveReaching } from "../src/runs.js";
import type { RunTotals } from "../src/types.js";
import { docsLong, syntheticSnapshot } from "./synthetic.js";

const cfg = withConfig();

function expectConserved(t: RunTotals) {
  expect(t.fundPaid + t.layerPaid + t.tradersLose).toBeCloseTo(t.badDebt, 6);
  expect(t.fundEnd).toBeCloseTo(t.fundStart + t.fundIncome - t.fundPaid, 6);
  expect(t.layerPaid).toBeLessThanOrEqual(t.layerLimit + 1e-9);
}

describe("single position", () => {
  it("survives a 5% drop", () => {
    const snap = syntheticSnapshot({ positions: [docsLong] });
    const r = stress(snap, 0.05, cfg);
    expect(r.totals.liquidations).toBe(0);
    expect(r.totals.band).toBe(0);
  });

  it("is liquidated on a 7% drop with margin to spare, feeding the fund", () => {
    const snap = syntheticSnapshot({ positions: [docsLong] });
    const r = stress(snap, 0.07, cfg);
    expect(r.totals.liquidations).toBe(1);
    expect(r.totals.badDebt).toBe(0);
    expect(r.totals.fundIncome).toBeGreaterThan(0);
    // Liquidated as the mark crossed $94,000, so the fill is just under it.
    const fill = r.events.find((e) => e.kind === "fill");
    expect(fill && fill.kind === "fill" && fill.price).toBeGreaterThan(93_000);
    expect(fill && fill.kind === "fill" && fill.price).toBeLessThan(94_000);
    expectConserved(r.totals);
  });

  it("under Perpl's rules, is deleveraged at the mark when the price gaps past bankruptcy", () => {
    // An instant 20% gap: the mark lands far below the $90,000 bankruptcy price.
    const snap = syntheticSnapshot({ positions: [docsLong], insuranceFund: 1_000 });
    const gapCfg = withConfig({ stress: { shockSeconds: 1, holdSeconds: 60 }, liquidation: { bankruptPolicy: "adl" } });
    const r = stress(snap, 0.2, gapCfg, { layerLimitUsd: 5_000 });
    const fill = r.events.find((e) => e.kind === "fill");
    expect(fill?.kind === "fill" && fill.path).toBe("gap");
    // Bad debt is the distance from bankruptcy to the mark, on 1 BTC.
    expect(r.totals.badDebt).toBeGreaterThan(9_000);
    expect(r.totals.fundPaid).toBeCloseTo(1_000, 6);
    expect(r.totals.layerPaid).toBeCloseTo(5_000, 6);
    expect(r.totals.tradersLose).toBeCloseTo(r.totals.badDebt - 6_000, 6);
    expect(r.totals.band).toBe(3);
    expectConserved(r.totals);
  });
});

describe("fund first", () => {
  it("takes a bankrupt position on and sells it into the book, below the mark", () => {
    const snap = syntheticSnapshot({ positions: [docsLong], insuranceFund: 1_000 });
    const gapCfg = withConfig({ stress: { shockSeconds: 1, holdSeconds: 60 }, backstop: { capacityUsd: 0 } });
    const r = stress(snap, 0.2, gapCfg, { layerLimitUsd: 5_000 });
    const fills = r.events.filter((e) => e.kind === "fill");
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) expect(f.kind === "fill" && f.path).toBe("system");
    // Selling into the book costs more than closing at the mark would.
    const atMark = stress(snap, 0.2, withConfig({ ...gapCfg, liquidation: { bankruptPolicy: "adl" } }), { layerLimitUsd: 5_000 });
    expect(r.totals.badDebt).toBeGreaterThan(atMark.totals.badDebt);
    expectConserved(r.totals);
  });
});

describe("a crowded market", () => {
  const snap = syntheticSnapshot({ randomPositions: 400, usdPerLevel: 5_000, insuranceFund: 20_000 });
  const thin = withConfig({ backstop: { capacityUsd: 0 } });

  it("conserves money on every move", () => {
    for (const move of [0.02, 0.05, 0.1, 0.2, 0.3]) expectConserved(stress(snap, move, thin).totals);
  });

  it("gives the same timeline twice", () => {
    const a = stress(snap, 0.15, thin);
    const b = stress(snap, 0.15, thin);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("forced selling drags Perpl's book below spot", () => {
    const r = stress(snap, 0.1, thin);
    expect(r.totals.bookLow).toBeLessThan(r.totals.spotEnd);
  });

  it("keeps the mark within 25 bps of spot", () => {
    const r = stress(snap, 0.2, thin);
    for (const f of r.frames) expect(Math.abs(f.mark / f.spot - 1)).toBeLessThanOrEqual(0.0025 + 1e-12);
  });

  it("removing the layer moves its share onto winning traders", () => {
    const withLayer = stress(snap, 0.3, thin).totals;
    const without = stress(snap, 0.3, thin, { layerLimitUsd: 0 }).totals;
    expect(without.layerPaid).toBe(0);
    expect(without.tradersLose).toBeCloseTo(withLayer.tradersLose + withLayer.layerPaid, 6);
  });

  it("a bigger drop liquidates at least as many positions", () => {
    const curve = stressCurve(snap, withConfig({ ...thin, stressGrid: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3] }));
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.totals.liquidations).toBeGreaterThanOrEqual(curve[i - 1]!.totals.liquidations);
    }
    expect(smallestMoveReaching(curve, 1)).not.toBeNull();
  });

  it("the backstop buyer takes what the book can not, at its discount", () => {
    const r = stress(snap, 0.12, withConfig({ backstop: { capacityUsd: 10_000_000 } }));
    const fills = r.events.filter((e) => e.kind === "fill" && e.path === "backstop");
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) {
      if (f.kind !== "fill") continue;
      // The mark sits within 25 bps of spot, and the buyer pays 5% under the mark.
      const frame = r.frames.find((x) => x.t === f.t)!;
      expect(f.price).toBeGreaterThanOrEqual(frame.spot * 0.9975 * 0.95 - 1e-6);
      expect(f.price).toBeLessThanOrEqual(frame.spot * 1.0025 * 0.95 + 1e-6);
    }
    expectConserved(r.totals);
  });
});
