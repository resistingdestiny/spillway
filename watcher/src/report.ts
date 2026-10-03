// Engine forecast against what the contracts booked, for one scenario run.
//
// Tolerance. Each money event is rounded on its own, so it is off by at most half a unit
// ($0.0000005). A rounding error moves the fund balance by the same amount, and that can carry
// into later draws, so a total can be off by at most one unit ($0.000001) per money event:
// half for the event itself and half for its effect on the fund. The check is
//   |on-chain - engine| <= events x $0.000001
// for every row. A second, stricter check replays the contracts' integer arithmetic on the
// rounded plan (plan.ts replayWaterfall); the chain has to match that to the unit.

import type { ScenarioRun, SentKind } from "./runner.js";
import { formatDollars, formatUnits, toDollars } from "./money.js";
import { configLabel } from "./scenario.js";

export const TOLERANCE_PER_EVENT = 0.000001;

export interface Row {
  metric: string;
  engine: number;
  chain: bigint;
  expected: bigint;
  /** chain - engine, in dollars. */
  diff: number;
  ok: boolean;
  exact: boolean;
}

export interface Comparison {
  rows: Row[];
  events: number;
  tolerance: number;
  bandEngine: number;
  bandChain: number;
  bandExpected?: number;
  withinTolerance: boolean;
  exactMatch: boolean;
  bandOk: boolean;
  pass: boolean;
  rounding: { maxAbs: number; sumAbs: number; net: number };
}

export function compare(run: ScenarioRun): Comparison {
  const { before: b, expected: x, engine } = run;
  const a = run.after;
  if (!a) throw new Error("run has no after state (dry run?)");
  const t = engine.totals;
  const events = run.plan.events.length;
  const tolerance = events * TOLERANCE_PER_EVENT;

  const fundIncomeChain = a.insuranceFund - b.insuranceFund + (a.fundPaid - b.fundPaid);
  const remainingExpected = b.remainingLimit - x.layerPaid;
  const raw: [string, number, bigint, bigint][] = [
    ["bad debt reported", t.badDebt, a.badDebtTotal - b.badDebtTotal, x.badDebtTotal],
    ["paid by insurance fund", t.fundPaid, a.fundPaid - b.fundPaid, x.fundPaid],
    ["paid by layer (adapter)", t.layerPaid, a.layerPaid - b.layerPaid, x.layerPaid],
    ["paid by layer (vault paidOut)", t.layerPaid, a.paidOut - b.paidOut, x.layerPaid],
    ["left to traders (ADL)", t.tradersLose, a.adlLoss - b.adlLoss, x.adlLoss],
    ["fund income", t.fundIncome, fundIncomeChain, x.fundIncome],
    ["insurance fund at end", t.fundEnd, a.insuranceFund, x.fundEnd],
    ["layer remaining limit", toDollars(b.remainingLimit) - t.layerPaid, a.remainingLimit, remainingExpected],
  ];
  const rows = raw.map(([metric, eng, chain, expected]) => {
    const diff = (Number(chain) - eng * 1e6) / 1e6;
    return { metric, engine: eng, chain, expected, diff, ok: Math.abs(diff) <= tolerance, exact: chain === expected };
  });

  const adl = a.adlLoss - b.adlLoss;
  const layer = a.layerPaid - b.layerPaid;
  const bad = a.badDebtTotal - b.badDebtTotal;
  const bandChain = adl > 0n ? 3 : layer > 0n ? 2 : bad > 0n ? 1 : 0;
  const bandExpected = run.spec.expectBand;
  const bandOk = bandChain === t.band && (bandExpected === undefined || bandExpected === t.band);

  const errs = run.plan.events.map((e) => toDollars(e.units) - e.dollars);
  const rounding = {
    maxAbs: errs.reduce((m, e) => Math.max(m, Math.abs(e)), 0),
    sumAbs: errs.reduce((s, e) => s + Math.abs(e), 0),
    net: errs.reduce((s, e) => s + e, 0),
  };

  const withinTolerance = rows.every((r) => r.ok);
  const exactMatch = rows.every((r) => r.exact);
  return {
    rows,
    events,
    tolerance,
    bandEngine: t.band,
    bandChain,
    bandExpected,
    withinTolerance,
    exactMatch,
    bandOk,
    pass: withinTolerance && exactMatch && bandOk,
    rounding,
  };
}

const signed = (d: number) => `${d >= 0 ? "+" : "-"}${Math.abs(d).toFixed(7)}`;

export function formatTable(run: ScenarioRun, cmp: Comparison): string {
  const head = ["", "engine ($)", "on chain ($)", "diff ($)", "within tol", "= integer replay"];
  const body = cmp.rows.map((r) => [r.metric, formatDollars(r.engine), formatUnits(r.chain), signed(r.diff), r.ok ? "yes" : "NO", r.exact ? "yes" : "NO"]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] as string).length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i] as number) : c.padStart(widths[i] as number))).join("  ");
  const out = [
    `${run.spec.name}: ${run.spec.label} (engine config: ${configLabel(run.spec)})`,
    line(head),
    line(widths.map((w) => "-".repeat(w))),
    ...body.map(line),
    `tolerance: ${cmp.events} money events x $${TOLERANCE_PER_EVENT.toFixed(6)} = $${cmp.tolerance.toFixed(6)}; ` +
      `largest |diff| $${Math.max(...cmp.rows.map((r) => Math.abs(r.diff))).toFixed(7)}`,
    `band: engine ${cmp.bandEngine}, chain ${cmp.bandChain}${cmp.bandExpected === undefined ? "" : `, expected ${cmp.bandExpected}`}` +
      ` (1 fund, 2 layer, 3 traders)`,
    `result: ${cmp.pass ? "PASS" : "FAIL"}`,
  ];
  return out.join("\n");
}

export interface GasSummary {
  setup?: bigint;
  runner: Partial<Record<SentKind, { txs: number; gas: bigint }>>;
  runnerTotal: bigint;
  keeper: { txs: number; gas: bigint };
  scenarioTotal: bigint;
}

export function gasSummary(run: ScenarioRun, keeper: { txs: number; gas: bigint }, setup?: bigint): GasSummary {
  const runner: GasSummary["runner"] = {};
  let runnerTotal = 0n;
  for (const s of run.sent) {
    const k = (runner[s.kind] ??= { txs: 0, gas: 0n });
    k.txs++;
    k.gas += s.gasUsed;
    runnerTotal += s.gasUsed;
  }
  return { setup, runner, runnerTotal, keeper, scenarioTotal: runnerTotal + keeper.gas };
}

export interface ReportExtra {
  network: string;
  chainId: number;
  snapshot?: { path: string; block: number; takenAt: string };
  gas?: GasSummary;
  payouts?: unknown[];
  [k: string]: unknown;
}

export function buildReport(run: ScenarioRun, cmp: Comparison, extra: ReportExtra) {
  const t = run.engine.totals;
  const counts: Record<string, number> = {};
  for (const e of run.engine.events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  const txCounts: Record<string, number> = {};
  for (const x of run.plan.txs) txCounts[x.kind] = (txCounts[x.kind] ?? 0) + 1;
  return {
    schema: "spillway.watcher-report/1",
    scenario: run.spec,
    tolerance: {
      rule: "|on-chain - engine| <= money events x $0.000001, for every row",
      perEvent: TOLERANCE_PER_EVENT,
      events: cmp.events,
      total: cmp.tolerance,
    },
    comparison: cmp.rows.map((r) => ({
      metric: r.metric,
      engine: r.engine,
      onChain: formatUnits(r.chain),
      integerReplay: formatUnits(r.expected),
      diff: Number(r.diff.toFixed(7)),
      withinTolerance: r.ok,
      matchesIntegerReplay: r.exact,
    })),
    checks: {
      withinTolerance: cmp.withinTolerance,
      matchesIntegerReplay: cmp.exactMatch,
      band: { engine: cmp.bandEngine, chain: cmp.bandChain, expected: cmp.bandExpected, ok: cmp.bandOk },
      pass: cmp.pass,
    },
    engine: {
      config: {
        label: configLabel(run.spec),
        base: "DEFAULT_CONFIG",
        overrides: run.spec.config ?? {},
        used: { stress: run.cfg.stress, bankruptPolicy: run.cfg.liquidation.bankruptPolicy, backstop: run.cfg.backstop, layerLimitUsd: run.cfg.layer.limitUsd },
      },
      ms: run.engineMs,
      start: { fund: formatUnits(run.start.fund), layerCapacity: formatUnits(run.start.layerCapacity) },
      totals: t,
      events: counts,
    },
    plan: {
      batching: run.plan.batching,
      moneyEvents: run.plan.events.length,
      transactions: run.plan.txs.length,
      byKind: txCounts,
      dust: run.plan.dust,
      rounding: {
        rule: "shortest decimal of each engine amount, rounded half up to 6 decimals, per event",
        ...cmp.rounding,
      },
    },
    chain: {
      before: run.before,
      after: run.after,
      finalizedAsAdl: formatUnits(run.finalized),
      blocks: run.after ? Number(run.after.block - run.before.block) : 0,
      ms: run.chainMs,
    },
    ...extra,
  };
}
