import type { TimelineEvent } from "@spillway/engine";
import { describe, expect, it } from "vitest";
import { moneyEvents, planTransactions, replayWaterfall } from "../src/plan.js";

const fill = (t: number, badDebt: number, residual = 0, accountId = 1): TimelineEvent => ({
  kind: "fill",
  t,
  accountId,
  side: "long",
  size: 1,
  price: 100,
  path: "book",
  liquidationPrice: 100,
  bankruptcyPrice: 96,
  residual,
  badDebt,
  bookPriceAfter: 99,
});
const income = (t: number, amount: number, accountId = 1): TimelineEvent => ({ t, kind: "fund_income", amount, accountId });
const draw = (t: number, amount: number): TimelineEvent => ({ t, kind: "fund_draw", amount, accountId: 1 });

describe("moneyEvents", () => {
  it("keeps only income and bad debt, in timeline order", () => {
    const timeline: TimelineEvent[] = [
      { t: 0, kind: "trigger", accountId: 1, side: "long", size: 1, mark: 100, liquidationPrice: 100 },
      fill(1, 0, 4),
      income(1, 0.4),
      fill(2, 10),
      draw(2, 10),
      { t: 2, kind: "layer_draw", amount: 0, accountId: 1 },
      { t: 2, kind: "settle" },
    ];
    const out = moneyEvents(timeline);
    expect(out.map((e) => [e.index, e.kind, e.units])).toEqual([
      [2, "fundInsurance", 400_000n],
      [3, "reportBadDebt", 10_000_000n],
    ]);
  });

  it("ignores fills that end with margin left (no bad debt)", () => {
    expect(moneyEvents([fill(1, 0, 5)])).toEqual([]);
  });
});

describe("planTransactions", () => {
  const timeline: TimelineEvent[] = [
    fill(1, 1.0000005),
    fill(1, 2),
    income(1, 0.5),
    fill(1, 3),
    income(2, 0.25),
    income(2, 0.25),
    fill(3, 0.0000004), // dust
    fill(3, 1),
  ];

  it("sends one transaction per event when asked", () => {
    const plan = planTransactions(timeline, "event");
    expect(plan.txs.map((x) => [x.kind, x.units])).toEqual([
      ["reportBadDebt", 1_000_001n],
      ["reportBadDebt", 2_000_000n],
      ["fundInsurance", 500_000n],
      ["reportBadDebt", 3_000_000n],
      ["fundInsurance", 250_000n],
      ["fundInsurance", 250_000n],
      ["reportBadDebt", 1_000_000n],
    ]);
    expect(plan.dust).toEqual({ count: 1, dollars: 0.0000004 });
  });

  it("merges same-kind runs within a step and keeps the order of income and draws", () => {
    const plan = planTransactions(timeline, "step");
    expect(plan.txs.map((x) => [x.kind, x.t, x.units, x.events])).toEqual([
      ["reportBadDebt", 1, 3_000_001n, 2],
      ["fundInsurance", 1, 500_000n, 1],
      ["reportBadDebt", 1, 3_000_000n, 1],
      ["fundInsurance", 2, 500_000n, 2],
      ["reportBadDebt", 3, 1_000_000n, 1],
    ]);
  });

  it("rounds each event before merging, so batching never changes the total", () => {
    const halves = [fill(5, 0.0000005), fill(5, 0.0000005), fill(5, 0.0000005)];
    const one = planTransactions(halves, "step");
    expect(one.txs).toHaveLength(1);
    expect(one.txs[0]?.units).toBe(3n);
    const each = planTransactions(halves, "event");
    expect(each.txs.reduce((s, x) => s + x.units, 0n)).toBe(3n);
  });

  it("does not merge across steps", () => {
    const plan = planTransactions([fill(1, 1), fill(2, 1)], "step");
    expect(plan.txs).toHaveLength(2);
  });
});

describe("replayWaterfall", () => {
  const tx = (kind: "fundInsurance" | "reportBadDebt", units: bigint) => ({ kind, t: 0, units, events: 1, dollars: 0 });

  it("pays from the fund first, then the layer, then ADL", () => {
    const r = replayWaterfall([tx("reportBadDebt", 70n), tx("fundInsurance", 5n), tx("reportBadDebt", 60n)], 100n, 20n);
    // fund 100 pays 70, gets 5, pays 35 of 60; shortfall 25, layer pays 20, ADL 5.
    expect(r).toEqual({ badDebtTotal: 130n, fundPaid: 105n, layerPaid: 20n, adlLoss: 5n, fundIncome: 5n, fundEnd: 0n });
  });

  it("gives the same totals for batched and unbatched plans", () => {
    const timeline: TimelineEvent[] = [];
    let seed = 3;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let t = 0; t < 200; t++) {
      for (let k = 0; k < 4; k++) {
        if (rand() < 0.5) timeline.push(fill(t, rand() * 900));
        else timeline.push(income(t, rand() * 20));
      }
    }
    const a = planTransactions(timeline, "event");
    const b = planTransactions(timeline, "step");
    expect(b.txs.length).toBeLessThan(a.txs.length);
    for (const [fund, cap] of [[1_000_000_000n, 50_000_000_000n], [50_000_000_000n, 10_000_000_000n], [0n, 0n]] as const) {
      expect(replayWaterfall(b.txs, fund, cap)).toEqual(replayWaterfall(a.txs, fund, cap));
    }
  });
});

describe("compact batching", () => {
  const bd = (t: number, d: number) => fill(t, d);
  const inc = (t: number, d: number) => income(t, d);
  const kinds = (timeline: TimelineEvent[], fund: bigint) =>
    planTransactions(timeline, "compact", fund).txs.map((x) => [x.kind, x.units / 1_000_000n]);

  it("puts bad debt first while the fund covers it", () => {
    expect(kinds([bd(1, 10), inc(2, 5), bd(3, 10)], 100_000_000n)).toEqual([
      ["reportBadDebt", 20n],
      ["fundInsurance", 5n],
    ]);
  });

  it("puts income first when the fund ends the run empty", () => {
    // 12 - 10 + 5 - 10: the fund pays 17 and ends at 0, as with income first.
    expect(kinds([bd(1, 10), inc(2, 5), bd(3, 10)], 12_000_000n)).toEqual([
      ["fundInsurance", 5n],
      ["reportBadDebt", 20n],
    ]);
  });

  it("splits a run when neither order gives the engine's end balance", () => {
    // From 0: +5, -10 (fund pays 5), +3. Ends at 3. Neither fold ends at 3.
    expect(kinds([inc(1, 5), bd(2, 10), inc(3, 3)], 0n)).toEqual([
      ["fundInsurance", 5n],
      ["reportBadDebt", 10n],
      ["fundInsurance", 3n],
    ]);
  });

  it("needs the starting fund", () => {
    expect(() => planTransactions([bd(1, 1)], "compact")).toThrow(/starting insurance fund/);
  });

  it("matches the step plan to the unit through fund exhaustion, the layer and ADL", () => {
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let trial = 0; trial < 40; trial++) {
      const timeline: TimelineEvent[] = [];
      for (let t = 0; t < 150; t++) {
        const n = 1 + Math.floor(rand() * 4);
        for (let k = 0; k < n; k++) timeline.push(rand() < 0.4 ? bd(t, rand() * 2000) : inc(t, rand() * 300));
      }
      const fund = BigInt(Math.floor(rand() * 60_000)) * 1_000_000n;
      const cap = BigInt(Math.floor(rand() * 40_000)) * 1_000_000n;
      const step = planTransactions(timeline, "step");
      const compact = planTransactions(timeline, "compact", fund);
      expect(compact.txs.length).toBeLessThanOrEqual(step.txs.length);
      expect(replayWaterfall(compact.txs, fund, cap)).toEqual(replayWaterfall(step.txs, fund, cap));
      const sum = (p: typeof step, k: string) => p.txs.filter((x) => x.kind === k).reduce((s, x) => s + x.units, 0n);
      expect(sum(compact, "reportBadDebt")).toBe(sum(step, "reportBadDebt"));
      expect(sum(compact, "fundInsurance")).toBe(sum(step, "fundInsurance"));
    }
  });
});
