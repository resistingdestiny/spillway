import { describe, expect, it } from "vitest";
import {
  bankruptcyPrice,
  equityAt,
  isLiquidatable,
  leverage,
  liquidationPrice,
  splitResidual,
} from "../src/margin.js";
import type { SnapshotPosition } from "../src/types.js";

// Perpl docs, Liquidation: "a $100k BTC long at 10x".
// $10,000 posted, $100,000 position, BTC maintenance margin 4%.
const docsExample: SnapshotPosition = {
  accountId: 1,
  side: "long",
  size: 1,
  entryPrice: 100_000,
  deposit: 10_000,
  premiumPnl: 0,
};
const BTC_MM = 0.04;

describe("Perpl worked example", () => {
  it("is 10x leverage", () => {
    expect(leverage(docsExample)).toBe(10);
  });

  it("liquidates at $94,000", () => {
    expect(liquidationPrice(docsExample, BTC_MM)).toBe(94_000);
  });

  it("is bankrupt at $90,000, where a 10% drop wipes out the $10,000", () => {
    expect(bankruptcyPrice(docsExample)).toBe(90_000);
  });

  it("leaves $4,000 of margin at $94,000, split $3,200 / $400 / $400", () => {
    const residual = equityAt(docsExample, 94_000);
    expect(residual).toBe(4_000);
    expect(splitResidual(residual, { trader: 0.8, insurance: 0.1, protocol: 0.1 })).toEqual({
      trader: 3_200,
      insurance: 400,
      protocol: 400,
    });
  });

  it("triggers at $94,000 and not a dollar above", () => {
    expect(isLiquidatable(docsExample, 94_001, BTC_MM)).toBe(false);
    expect(isLiquidatable(docsExample, 94_000, BTC_MM)).toBe(true);
  });
});

describe("shorts mirror longs", () => {
  const short: SnapshotPosition = { ...docsExample, side: "short" };

  it("liquidates 6% above entry and is bankrupt 10% above", () => {
    expect(liquidationPrice(short, BTC_MM)).toBe(106_000);
    expect(bankruptcyPrice(short)).toBe(110_000);
  });

  it("goes into bad debt above the bankruptcy price", () => {
    expect(equityAt(short, 112_000)).toBe(-2_000);
  });
});

describe("funding moves both prices", () => {
  it("funding received pushes a long's liquidation price down", () => {
    const paid = { ...docsExample, premiumPnl: 500 };
    expect(liquidationPrice(paid, BTC_MM)).toBe(93_500);
    expect(bankruptcyPrice(paid)).toBe(89_500);
  });
});
