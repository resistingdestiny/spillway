// From the engine's timeline to the transactions that mirror its money flow on chain.
//
// Only two kinds of engine event move money into or out of the insurance fund:
//   fund_income  ->  adapter.fundInsurance(amount)   margin left after a liquidation
//   fill.badDebt ->  adapter.reportBadDebt(amount)   loss beyond the trader's margin
// The engine's fund_draw, layer_draw and adl events are how it split each bad debt. On chain
// the adapter and the vault make that split themselves, so they are not sent. They are what
// the on-chain totals are checked against.
//
// Every amount is rounded to 6 decimals on its own (see money.ts). An amount that rounds to
// zero is dust: it cannot be sent (the adapter rejects zero) and is counted in the report.
//
// Batching. "event" sends one transaction per engine event. "step" merges consecutive events
// of the same kind within one engine step into one transaction. Order is kept, so an income
// that came between two bad debts still lands between them. Merging two bad debts gives the
// same fund path as sending them one after the other: the fund pays min(fund, a + b), which
// equals min(fund, a) plus min(what is left, b). Merging two incomes is a plain sum.
//
// "compact" is for a real network, where every transaction costs time and gas. It folds a run
// of events into at most two calls, all bad debt then all income or the other way round, as
// long as the fund ends the run at the same balance as it does in the engine's order. Within a
// run the fund only moves by income in and draws out, so the same end balance means the same
// fund paid and the same shortfall, and the layer and ADL split the running shortfall the same
// way. Totals match the step plan to the unit (the tests check it). What is lost is the path
// inside each run: the chain shows the cascade in a few large steps instead of second by second.

import type { TimelineEvent } from "@spillway/engine";
import { toUnits } from "./money.js";

export type TxKind = "fundInsurance" | "reportBadDebt";
export type Batching = "event" | "step" | "compact";

export interface MoneyEvent {
  /** Index in the engine's event list. */
  index: number;
  t: number;
  kind: TxKind;
  accountId: number;
  /** The engine's amount, in dollars. */
  dollars: number;
  /** The same amount rounded half up to 6 decimals, in base units. 0 means dust. */
  units: bigint;
}

export interface PlannedTx {
  kind: TxKind;
  /** Engine time of the step these events came from. */
  t: number;
  units: bigint;
  /** Engine events merged into this transaction. */
  events: number;
  /** Sum of the engine's unrounded amounts. */
  dollars: number;
}

export interface Plan {
  batching: Batching;
  events: MoneyEvent[];
  txs: PlannedTx[];
  /** Events that rounded to zero and were not sent. */
  dust: { count: number; dollars: number };
}

/** The engine events that move money, in timeline order, each rounded on its own. */
export function moneyEvents(timeline: readonly TimelineEvent[]): MoneyEvent[] {
  const out: MoneyEvent[] = [];
  timeline.forEach((e, index) => {
    if (e.kind === "fund_income" && e.amount > 0) {
      out.push({ index, t: e.t, kind: "fundInsurance", accountId: e.accountId, dollars: e.amount, units: toUnits(e.amount) });
    } else if (e.kind === "fill" && e.badDebt > 0) {
      out.push({ index, t: e.t, kind: "reportBadDebt", accountId: e.accountId, dollars: e.badDebt, units: toUnits(e.badDebt) });
    }
  });
  return out;
}

/**
 * Turns the engine's timeline into the ordered list of adapter calls. "compact" needs the
 * insurance fund the chain starts from, in base units.
 */
export function planTransactions(timeline: readonly TimelineEvent[], batching: Batching = "step", fundStart?: bigint): Plan {
  const events = moneyEvents(timeline);
  const dust = { count: 0, dollars: 0 };
  const live: MoneyEvent[] = [];
  for (const e of events) {
    if (e.units > 0n) live.push(e);
    else {
      dust.count++;
      dust.dollars += e.dollars;
    }
  }
  if (batching === "compact") {
    if (fundStart === undefined) throw new Error("compact batching needs the starting insurance fund");
    return { batching, events, txs: compactTxs(live, fundStart), dust };
  }
  const txs: PlannedTx[] = [];
  for (const e of live) {
    const last = txs[txs.length - 1];
    if (batching === "step" && last && last.kind === e.kind && last.t === e.t) {
      last.units += e.units;
      last.events++;
      last.dollars += e.dollars;
    } else {
      txs.push({ kind: e.kind, t: e.t, units: e.units, events: 1, dollars: e.dollars });
    }
  }
  return { batching, events, txs, dust };
}

const sub0 = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

/** Fund balance after one event, as the adapter computes it. */
const fundAfter = (fund: bigint, e: MoneyEvent) => (e.kind === "fundInsurance" ? fund + e.units : sub0(fund, e.units));

interface Run {
  /** Fund before the run. */
  from: bigint;
  /** Fund after the run, in the engine's order. */
  end: bigint;
  bad: bigint;
  income: bigint;
  badEvents: number;
  incomeEvents: number;
  badDollars: number;
  incomeDollars: number;
  t: number;
}

/** Fund after the run if all bad debt goes first. */
const endBadFirst = (r: Pick<Run, "from" | "bad" | "income">) => sub0(r.from, r.bad) + r.income;
/** Fund after the run if all income goes first. */
const endIncomeFirst = (r: Pick<Run, "from" | "bad" | "income">) => sub0(r.from + r.income, r.bad);

function compactTxs(events: readonly MoneyEvent[], fundStart: bigint): PlannedTx[] {
  const txs: PlannedTx[] = [];
  const emit = (r: Run) => {
    const bad: PlannedTx = { kind: "reportBadDebt", t: r.t, units: r.bad, events: r.badEvents, dollars: r.badDollars };
    const income: PlannedTx = { kind: "fundInsurance", t: r.t, units: r.income, events: r.incomeEvents, dollars: r.incomeDollars };
    const order = endBadFirst(r) === r.end ? [bad, income] : [income, bad];
    for (const tx of order) if (tx.units > 0n) txs.push(tx);
  };
  let run: Run | null = null;
  let fund = fundStart;
  for (const e of events) {
    const isBad = e.kind === "reportBadDebt";
    if (run) {
      const next: Run = {
        ...run,
        end: fundAfter(run.end, e),
        bad: run.bad + (isBad ? e.units : 0n),
        income: run.income + (isBad ? 0n : e.units),
        badEvents: run.badEvents + (isBad ? 1 : 0),
        incomeEvents: run.incomeEvents + (isBad ? 0 : 1),
        badDollars: run.badDollars + (isBad ? e.dollars : 0),
        incomeDollars: run.incomeDollars + (isBad ? 0 : e.dollars),
        t: e.t,
      };
      if (endBadFirst(next) === next.end || endIncomeFirst(next) === next.end) {
        run = next;
        continue;
      }
      emit(run);
      fund = run.end;
    }
    run = {
      from: fund,
      end: fundAfter(fund, e),
      bad: isBad ? e.units : 0n,
      income: isBad ? 0n : e.units,
      badEvents: isBad ? 1 : 0,
      incomeEvents: isBad ? 0 : 1,
      badDollars: isBad ? e.dollars : 0,
      incomeDollars: isBad ? 0 : e.dollars,
      t: e.t,
    };
  }
  if (run) emit(run);
  return txs;
}

export interface WaterfallTotals {
  badDebtTotal: bigint;
  fundPaid: bigint;
  layerPaid: bigint;
  adlLoss: bigint;
  fundIncome: bigint;
  fundEnd: bigint;
}

/**
 * What the adapter and vault should book for a plan, in exact integers: the contracts' own
 * arithmetic replayed off chain. Assumes the keeper settles every shortfall before the runner
 * finalizes, so the layer pays min(total shortfall, capacity) whatever the timing.
 * `layerCapacity` is the most the vault can pay: min(remaining limit, principal).
 */
export function replayWaterfall(txs: readonly PlannedTx[], fundStart: bigint, layerCapacity: bigint): WaterfallTotals {
  let fund = fundStart;
  let layerLeft = layerCapacity;
  const r: WaterfallTotals = { badDebtTotal: 0n, fundPaid: 0n, layerPaid: 0n, adlLoss: 0n, fundIncome: 0n, fundEnd: 0n };
  for (const tx of txs) {
    if (tx.kind === "fundInsurance") {
      fund += tx.units;
      r.fundIncome += tx.units;
      continue;
    }
    r.badDebtTotal += tx.units;
    const draw = tx.units < fund ? tx.units : fund;
    fund -= draw;
    r.fundPaid += draw;
    const rest = tx.units - draw;
    const cover = rest < layerLeft ? rest : layerLeft;
    layerLeft -= cover;
    r.layerPaid += cover;
    r.adlLoss += rest - cover;
  }
  r.fundEnd = fund;
  return r;
}
