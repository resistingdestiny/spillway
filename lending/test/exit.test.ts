import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG as cfg } from "../src/config.js";
import { depthWithin, exitDepth } from "../src/exit.js";
import { liquidationIncentive } from "../src/model.js";

const q = (...losses: (number | null)[]): [number, number | null][] =>
  [1_000, 100_000, 1_000_000, 10_000_000].map((size, i) => [size, losses[i] === null ? null : -(losses[i] as number)]);

describe("exit depth from quotes", () => {
  it("interpolates linearly in size between the quoted sizes", () => {
    // 1% at $1k, 3% at $100k: 2% is halfway, at $50.5k.
    expect(depthWithin(q(0.01, 0.03, 0.5, 0.9), 0.02)).toBeCloseTo(50_500, 6);
  });

  it("is zero when $1k already loses too much, and when there is no route", () => {
    expect(depthWithin(q(0.05, 0.1, 0.2, 0.3), 0.02)).toBe(0);
    expect(depthWithin(q(null, null, null, null), 0.5)).toBe(0);
  });

  it("reads a missing route at a larger size as receiving nothing", () => {
    // 0.83% at $1M, no route at $10M: the loss climbs to 100% at $10M.
    expect(depthWithin(q(0.0006, 0.0011, 0.0083, null), 0.0255)).toBeCloseTo(1_000_000 + ((0.0255 - 0.0083) / (1 - 0.0083)) * 9_000_000, 3);
  });

  it("does not extrapolate past the largest quote", () => {
    expect(depthWithin(q(0, 0, 0, 0.01), 0.02)).toBe(10_000_000);
  });

  it("uses each market's own incentive: wstETH sells about $6k into a 94.5% LLTV market", () => {
    const wsteth = { address: "0x10aeaf63194db8d453d4d85a06e5efe1dd0b5417", symbol: "wstETH" };
    const tight = exitDepth(wsteth, liquidationIncentive(0.945, cfg), cfg);
    expect(tight.source).toBe("quotes");
    expect(tight.maxLoss).toBeCloseTo(1 - 1 / 1.0168, 4);
    expect(tight.depthUsd).toBeCloseTo(1_000 + ((tight.maxLoss - 0.0072) / (0.1861 - 0.0072)) * 99_000, 6);
    expect(tight.depthUsd as number).toBeGreaterThan(5_000);
    expect(tight.depthUsd as number).toBeLessThan(7_000);
    // A lower LLTV pays a larger incentive and can sell more.
    expect(exitDepth(wsteth, liquidationIncentive(0.86, cfg), cfg).depthUsd as number).toBeGreaterThan(tight.depthUsd as number);
  });

  it("leaves unmeasured tokens without a limit, and lets the override win", () => {
    const weth = { address: "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242", symbol: "WETH" };
    expect(exitDepth(weth, 1.04, cfg)).toMatchObject({ source: "unmeasured", depthUsd: null });
    const over = { ...cfg, thinExit: { ...cfg.thinExit, exitDepthUsd: { [weth.address]: 123 } } };
    expect(exitDepth(weth, 1.04, over)).toMatchObject({ source: "override", depthUsd: 123 });
  });
});
