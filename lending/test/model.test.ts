import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { liquidationIncentive, positionOutcome, thresholds } from "../src/model.js";

const lif = (lltv: number) => liquidationIncentive(lltv, DEFAULT_CONFIG);

describe("liquidation incentive factor", () => {
  it("matches the values in docs/LENDING.md", () => {
    expect(lif(0.945)).toBeCloseTo(1.0168, 4);
    expect(lif(0.915)).toBeCloseTo(1.0262, 4);
    expect(lif(0.86)).toBeCloseTo(1.0438, 4);
    expect(lif(0.77)).toBeCloseTo(1.0741, 4);
  });

  it("is capped at 1.15 for low LLTVs", () => {
    expect(lif(0.385)).toBe(1.15);
    expect(lif(0)).toBe(1.15);
  });
});

// A 86% LLTV market: LIF 1.0438. 1,000 of debt against collateral worth 1,200 (HF 1.032).
const base = { debt: 1_000, lltv: 0.86, lif: lif(0.86), fill: 1 };
const at = (value: number, extra: Partial<typeof base & { marketValue: number }> = {}) =>
  positionOutcome({ ...base, oracleValue: value, marketValue: value, ...extra });

describe("position outcomes", () => {
  it("healthy: collateral * LLTV covers the debt, no loss", () => {
    const r = at(1_200);
    expect(r.outcome).toBe("healthy");
    expect(r.liquidatable).toBe(false);
    expect(r.realised + r.unrealised).toBe(0);
  });

  it("liquidated with no loss: value / LIF >= debt, the borrower keeps the rest", () => {
    // 1,100 * 0.86 = 946 < 1,000, so liquidatable. 1,100 / 1.0438 = 1,053.8 >= 1,000.
    const r = at(1_100);
    expect(r.outcome).toBe("liquidated");
    expect(r.repaid).toBe(1_000);
    expect(r.seized).toBeCloseTo(1_000 * base.lif, 9);
    expect(r.realised).toBe(0);
  });

  it("liquidated with bad debt: debt - value / LIF, realised at once", () => {
    const r = at(1_000);
    expect(r.outcome).toBe("bad-debt");
    expect(r.seized).toBe(1_000);
    expect(r.realised).toBeCloseTo(1_000 - 1_000 / base.lif, 9);
    expect(r.unrealised).toBe(0);
  });

  it("not liquidated: max(0, debt - value), unrealised", () => {
    expect(at(900, { fill: 0 })).toMatchObject({ outcome: "unrealised", realised: 0, unrealised: 100 });
    // Liquidatable but still worth more than the debt: no loss yet, even with nobody liquidating.
    expect(at(1_100, { fill: 0 })).toMatchObject({ outcome: "healthy", liquidatable: true, unrealised: 0 });
  });

  it("thin exit: a partial liquidation of an underwater position realises nothing and leaves a larger hole", () => {
    const half = at(1_000, { fill: 0.5 });
    expect(half.outcome).toBe("unrealised");
    expect(half.realised).toBe(0);
    // Between nobody liquidating (0) and liquidating all of it (debt - value / LIF).
    expect(half.unrealised).toBeGreaterThan(0);
    expect(half.unrealised).toBeLessThan(1_000 - 1_000 / base.lif);
    expect(half.unrealised).toBeCloseTo(0.5 * (1_000 - 1_000 / base.lif), 9);
  });

  it("hidden loss: the oracle holds, nothing is liquidated, the loss is unrealised", () => {
    const r = at(1_200, { marketValue: 600 });
    expect(r.outcome).toBe("unrealised");
    expect(r.liquidatable).toBe(false);
    expect(r.unrealised).toBe(400);
  });

  it("liquidators wait when the market pays less than they repay", () => {
    // Liquidatable at the oracle, but the collateral sells for half: seizing it loses money.
    const r = at(1_100, { marketValue: 550 });
    expect(r.repaid).toBe(0);
    expect(r.unrealised).toBe(450);
  });

  it("a position with no debt is healthy whatever happens", () => {
    expect(at(0, { debt: 0 }).outcome).toBe("healthy");
  });
});

describe("thresholds", () => {
  it("gives the fall to liquidation and to bad debt", () => {
    const t = thresholds(1_000, 1_200, 0.86, base.lif);
    expect(t.liquidation).toBeCloseTo(1 - 1_000 / (1_200 * 0.86), 12);
    expect(t.badDebt).toBeCloseTo(1 - (1_000 * base.lif) / 1_200, 12);
    expect(at(1_200 * (1 - t.liquidation) - 1e-6).liquidatable).toBe(true);
    expect(at(1_200 * (1 - t.badDebt) - 1e-6).outcome).toBe("bad-debt");
    expect(at(1_200 * (1 - t.badDebt) + 1e-6).outcome).toBe("liquidated");
  });
});
