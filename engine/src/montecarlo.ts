// Monte Carlo: how often does the water reach each band in a year?
//
// Method. The stress curve says how much bad debt each size of drop leaves on today's book. History
// says how often BTC has fallen that far within a day. We sample whole years of daily moves from
// history (with replacement), look up each day's loss on the curve, and count.
//
// Assumptions, stated here because they drive the answer:
//   - Today's positions, book, fund and layer are what the market looks like on every day of the year.
//   - Each bad day is independent and starts with the fund at today's balance.
//   - A day's move is its open-to-low fall (open-to-high rise for shorts), applied as a stress run.
//   - The layer's limit is aggregate over the year: once used up, it is gone.

import type { EngineConfig } from "./config.js";
import { mulberry32, randInt } from "./rng.js";
import type { StressPoint } from "./runs.js";

/** Daily candles: [unix, open, high, low, close]. */
export interface DailyHistory {
  source: string;
  rows: [number, number, number, number, number][];
}

/** Days where the source printed an impossible low. Coinbase printed BTC at $0.06 on 15 April 2017. */
export const BAD_PRINTS = new Set(["2017-04-15"]);

export interface DailyMoves {
  source: string;
  from: string;
  to: string;
  /** Open-to-low fall per day, as a fraction. */
  down: number[];
  /** Open-to-high rise per day, as a fraction. */
  up: number[];
}

export function dailyMoves(history: DailyHistory): DailyMoves {
  const rows = history.rows.filter(([t]) => !BAD_PRINTS.has(new Date(t * 1000).toISOString().slice(0, 10)));
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  return {
    source: history.source,
    from: day(rows[0]?.[0] ?? 0),
    to: day(rows[rows.length - 1]?.[0] ?? 0),
    down: rows.map(([, open, , low]) => Math.max(0, 1 - low / open)),
    up: rows.map(([, open, high]) => Math.max(0, high / open - 1)),
  };
}

export interface Loss {
  badDebt: number;
  fundPaid: number;
  layerPaid: number;
  tradersLose: number;
}

/**
 * Loss for a move between grid points. Bad debt and the fund's income from the cascade are
 * interpolated; the split between fund, layer and traders is then recomputed, because splitting
 * each share separately would break the waterfall. Moves past the grid use its last point.
 */
export function lossAt(curve: StressPoint[], move: number): Loss {
  const zero = { badDebt: 0, fundPaid: 0, layerPaid: 0, tradersLose: 0 };
  if (curve.length === 0 || move <= 0) return zero;
  const last = curve[curve.length - 1] as StressPoint;
  let badDebt = last.totals.badDebt;
  let income = last.totals.fundIncome;
  if (move < last.move) {
    let loMove = 0;
    let loBad = 0;
    let loIncome = 0;
    for (const p of curve) {
      if (p.move >= move) {
        const w = (move - loMove) / (p.move - loMove);
        badDebt = loBad + w * (p.totals.badDebt - loBad);
        income = loIncome + w * (p.totals.fundIncome - loIncome);
        break;
      }
      loMove = p.move;
      loBad = p.totals.badDebt;
      loIncome = p.totals.fundIncome;
    }
  }
  if (badDebt <= 0) return zero;
  const fund = last.totals.fundStart + income;
  const fundPaid = Math.min(fund, badDebt);
  const layerPaid = Math.min(last.totals.layerLimit, badDebt - fundPaid);
  return { badDebt, fundPaid, layerPaid, tradersLose: badDebt - fundPaid - layerPaid };
}

export interface Plaque {
  /** "1 in N years". */
  returnPeriodYears: number;
  /** Bad debt of the worst day in such a year. */
  badDebt: number;
  /** Which band that water reaches: 0 dry, 1 fund, 2 layer, 3 traders. */
  band: 0 | 1 | 2 | 3;
}

export interface MonteCarloResult {
  years: number;
  seed: number;
  daysPerYear: number;
  history: { source: string; from: string; to: string; days: number };
  fund: number;
  layerLimit: number;
  /** Chance in a year that at least one day leaves bad debt the fund pays. */
  pFund: number;
  /** Chance in a year that the layer pays something. */
  pLayer: number;
  /** Chance in a year that winning traders are deleveraged. */
  pTraders: number;
  /** Average yearly amounts. */
  expected: Loss;
  /** Chance in a year that the worst day's bad debt reaches each level. */
  exceedance: { level: number; p: number }[];
  /** High-water marks for the basin wall. */
  plaques: Plaque[];
}

export function monteCarlo(
  curve: StressPoint[],
  moves: number[],
  cfg: EngineConfig,
  fund: number,
  layerLimit: number,
  history: { source: string; from: string; to: string } = { source: "", from: "", to: "" },
): MonteCarloResult {
  const { years, seed, daysPerYear } = cfg.monteCarlo;
  const rng = mulberry32(seed);
  const n = moves.length;

  // Every day's loss depends only on its move, so look each historical day up once.
  const dayLoss = moves.map((m) => lossAt(curve, m));

  const worst = new Float64Array(years);
  let hitFund = 0;
  let hitLayer = 0;
  let hitTraders = 0;
  const sum: Loss = { badDebt: 0, fundPaid: 0, layerPaid: 0, tradersLose: 0 };

  for (let y = 0; y < years; y++) {
    let worstDay = 0;
    let layerUsed = 0;
    let fundHit = false;
    let tradersHit = false;
    for (let d = 0; d < daysPerYear; d++) {
      const l = dayLoss[randInt(rng, n)] as Loss;
      if (l.badDebt <= 0) continue;
      if (l.badDebt > worstDay) worstDay = l.badDebt;
      if (l.fundPaid > 0) fundHit = true;
      // Aggregate limit: what the layer can no longer pay falls on traders.
      const layerPays = Math.min(l.layerPaid, layerLimit - layerUsed);
      layerUsed += layerPays;
      const traders = l.tradersLose + (l.layerPaid - layerPays);
      if (traders > 0) tradersHit = true;
      sum.badDebt += l.badDebt;
      sum.fundPaid += l.fundPaid;
      sum.layerPaid += layerPays;
      sum.tradersLose += traders;
    }
    worst[y] = worstDay;
    if (fundHit) hitFund++;
    if (layerUsed > 0) hitLayer++;
    if (tradersHit) hitTraders++;
  }

  const sorted = Array.from(worst).sort((a, b) => a - b);
  const quantile = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))] ?? 0;
  const bandOf = (bd: number): 0 | 1 | 2 | 3 => (bd <= 0 ? 0 : bd <= fund ? 1 : bd <= fund + layerLimit ? 2 : 3);

  const top = sorted[sorted.length - 1] ?? 0;
  const levels = [fund * 0.25, fund * 0.5, fund, fund + layerLimit * 0.5, fund + layerLimit, (fund + layerLimit) * 1.5];
  if (top > 0) levels.push(top);
  const exceedance = levels
    .filter((level) => level > 0)
    .sort((a, b) => a - b)
    .map((level) => ({ level, p: sorted.filter((w) => w >= level).length / years }));

  const plaques: Plaque[] = [10, 25, 50, 100, 250, 1000]
    .filter((rp) => rp <= years)
    .map((rp) => {
      const badDebt = quantile(1 - 1 / rp);
      return { returnPeriodYears: rp, badDebt, band: bandOf(badDebt) };
    });

  return {
    years,
    seed,
    daysPerYear,
    history: { ...history, days: n },
    fund,
    layerLimit,
    pFund: hitFund / years,
    pLayer: hitLayer / years,
    pTraders: hitTraders / years,
    expected: {
      badDebt: sum.badDebt / years,
      fundPaid: sum.fundPaid / years,
      layerPaid: sum.layerPaid / years,
      tradersLose: sum.tradersLose / years,
    },
    exceedance,
    plaques,
  };
}
