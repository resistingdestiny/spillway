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

import type { TimelineEvent } from "@spillway/engine";
import { toUnits } from "./money.js";

export type TxKind = "fundInsurance" | "reportBadDebt";
export type Batching = "event" | "step";

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

/** Turns the engine's timeline into the ordered list of adapter calls. */
export function planTransactions(timeline: readonly TimelineEvent[], batching: Batching = "step"): Plan {
  const events = moneyEvents(timeline);
  const txs: PlannedTx[] = [];
  const dust = { count: 0, dollars: 0 };
  for (const e of events) {
    if (e.units === 0n) {
      dust.count++;
      dust.dollars += e.dollars;
      continue;
    }
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
