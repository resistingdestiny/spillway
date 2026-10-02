// The cascade: move the outside price along a path and play Perpl's liquidations forward.
//
// Each step:
//   1. Spot moves along the path. This is the ghost marker: the move the news caused.
//   2. Eaten book depth refills a little, nearest spot first.
//   3. The mark is set from spot and Perpl's own book, clamped near spot as Perpl does.
//   4. Positions whose liquidation price the mark has reached are flagged.
//   5. Flagged positions are sold into the book, but no further below the mark than a slippage
//      floor. What the book can not take goes to the backstop buyer while it has capacity. The rest
//      waits for depth to refill. A position the mark carries past its bankruptcy price is either
//      taken on by the fund and sold at any price (fund first, the waterfall Spillway proposes), or
//      deleveraged against winners at the mark (Perpl today). See liquidation.bankruptPolicy.
//   6. Margin left after a fill feeds the insurance fund. A fill past the bankruptcy price leaves bad
//      debt, paid by the fund, then the Spillway layer, then winning traders.
//
// The run is deterministic: same snapshot, config and path give the same timeline.

import { BookSide } from "./book.js";
import type { EngineConfig } from "./config.js";
import { bankruptcyPrice, equityAt, liquidationPrice, sign } from "./margin.js";
import type {
  Frame,
  LiquidationFill,
  LiquidationPath,
  PricePath,
  RunResult,
  RunTotals,
  Snapshot,
  SnapshotPosition,
  TimelineEvent,
} from "./types.js";

export interface SimulateOptions {
  kind: "stress" | "replay";
  label: string;
  direction: "down" | "up";
  path: PricePath;
  /** Keep stepping this long after the path ends if liquidations are still pending. */
  drainSeconds?: number;
  /** Skip frames and events to save memory when only totals are needed. */
  totalsOnly?: boolean;
  /** Override the layer limit, e.g. 0 to show the market without Spillway. */
  layerLimitUsd?: number;
}

interface Pos {
  p: SnapshotPosition;
  liq: number;
  bank: number;
  remaining: number;
  readyStep: number;
  triggered: boolean;
  done: boolean;
}

const EPS = 1e-12;

export function ratioAt(path: PricePath, t: number): number {
  const { t: ts, ratio } = path;
  const n = ts.length;
  if (n === 0) return 1;
  if (t <= (ts[0] as number)) return ratio[0] as number;
  if (t >= (ts[n - 1] as number)) return ratio[n - 1] as number;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((ts[mid] as number) <= t) lo = mid;
    else hi = mid;
  }
  const t0 = ts[lo] as number;
  const t1 = ts[hi] as number;
  const r0 = ratio[lo] as number;
  const r1 = ratio[hi] as number;
  return r0 + ((r1 - r0) * (t - t0)) / (t1 - t0);
}

export function simulate(snapshot: Snapshot, cfg: EngineConfig, opts: SimulateOptions): RunResult {
  const m = snapshot.market;
  const mm = m.maintenanceMarginFraction;
  const split = m.liquidationSplit ?? cfg.liquidation.split;
  const down = opts.direction === "down";
  const atRisk: "long" | "short" = down ? "long" : "short";
  const s = down ? 1 : -1; // +1 when longs are at risk

  // Positions on the losing side, in the order the move reaches them.
  const positions: Pos[] = snapshot.positions
    .filter((p) => p.side === atRisk && p.size > 0)
    .map((p) => ({
      p,
      liq: liquidationPrice(p, mm),
      bank: bankruptcyPrice(p),
      remaining: p.size,
      readyStep: 0,
      triggered: false,
      done: false,
    }))
    .sort((a, b) => s * (b.liq - a.liq) || a.p.accountId - b.p.accountId);

  const book = BookSide.fromSnapshot(snapshot, down ? "bid" : "ask", cfg);
  const spot0 = m.oraclePrice > 0 ? m.oraclePrice : m.markPrice;
  const dt = cfg.stepSeconds;
  const pathEnd = opts.path.t[opts.path.t.length - 1] ?? 0;
  const maxT = pathEnd + (opts.drainSeconds ?? 600);
  const layerLimit = opts.layerLimitUsd ?? cfg.layer.limitUsd;

  let backstopLeft = cfg.backstop.capacityUsd;
  let fund = m.insuranceFund;
  let layerRemaining = layerLimit;
  let firstOpen = 0;

  const totals: RunTotals = {
    badDebt: 0,
    fundPaid: 0,
    layerPaid: 0,
    tradersLose: 0,
    fundIncome: 0,
    liquidatedNotional: 0,
    liquidations: 0,
    bankruptcies: 0,
    fundStart: fund,
    fundEnd: fund,
    layerLimit,
    spotStart: spot0,
    spotEnd: spot0,
    bookLow: spot0,
    duration: 0,
    band: 0,
  };
  const frames: Frame[] = [];
  const events: TimelineEvent[] = [];
  const record = !opts.totalsOnly;

  const absorb = (badDebt: number, accountId: number, t: number) => {
    totals.badDebt += badDebt;
    const fromFund = Math.min(fund, badDebt);
    fund -= fromFund;
    totals.fundPaid += fromFund;
    const fromLayer = Math.min(layerRemaining, badDebt - fromFund);
    layerRemaining -= fromLayer;
    totals.layerPaid += fromLayer;
    const fromTraders = badDebt - fromFund - fromLayer;
    totals.tradersLose += fromTraders;
    if (record) {
      if (fromFund > 0) events.push({ t, kind: "fund_draw", amount: fromFund, accountId });
      if (fromLayer > 0) events.push({ t, kind: "layer_draw", amount: fromLayer, accountId });
      if (fromTraders > 0) events.push({ t, kind: "adl", amount: fromTraders, accountId });
    }
  };

  const fill = (pos: Pos, size: number, price: number, path: LiquidationPath, t: number, spot: number) => {
    const equity = equityAt(pos.p, price, size);
    const residual = Math.max(0, equity);
    const badDebt = Math.max(0, -equity);
    pos.remaining -= size;
    if (pos.remaining <= EPS * pos.p.size) {
      pos.remaining = 0;
      pos.done = true;
      totals.liquidations += 1;
      if (sign(pos.p.side) * (price - pos.bank) <= 0) totals.bankruptcies += 1;
    }
    totals.liquidatedNotional += size * price;
    const after = book.bookPrice(spot);
    if (record) {
      const f: LiquidationFill = {
        t,
        accountId: pos.p.accountId,
        side: pos.p.side,
        size,
        price,
        path,
        liquidationPrice: pos.liq,
        bankruptcyPrice: pos.bank,
        residual,
        badDebt,
        bookPriceAfter: after,
      };
      events.push({ kind: "fill", ...f });
    }
    if (residual > 0) {
      const income = residual * split.insurance;
      fund += income;
      totals.fundIncome += income;
      if (record && income > 0) events.push({ t, kind: "fund_income", amount: income, accountId: pos.p.accountId });
    }
    if (badDebt > 0) absorb(badDebt, pos.p.accountId, t);
  };

  let step = 0;
  for (;;) {
    const t = step * dt;
    const spot = spot0 * ratioAt(opts.path, t);
    if (step > 0) book.refill(dt, cfg.book.refillSeconds);

    const markOf = () => {
      const local = book.bookPrice(spot);
      const blended = (1 - cfg.mark.localBookWeight) * spot + cfg.mark.localBookWeight * local;
      const band = cfg.mark.bandToSpot;
      return Math.min(spot * (1 + band), Math.max(spot * (1 - band), blended));
    };
    let mark = markOf();

    // Flag positions the mark has reached. The list is sorted, so stop at the first one it has not.
    while (firstOpen < positions.length && (positions[firstOpen] as Pos).done) firstOpen++;
    for (let i = firstOpen; i < positions.length; i++) {
      const pos = positions[i] as Pos;
      if (s * (mark - pos.liq) > 0) break;
      if (pos.done || pos.triggered) continue;
      pos.triggered = true;
      pos.readyStep = step + cfg.liquidation.delaySteps;
      if (record) {
        events.push({ t, kind: "trigger", accountId: pos.p.accountId, side: pos.p.side, size: pos.remaining, mark, liquidationPrice: pos.liq });
      }
    }

    // Execute liquidations whose delay has passed.
    let pending = 0;
    for (let i = firstOpen; i < positions.length; i++) {
      const pos = positions[i] as Pos;
      if (pos.done || !pos.triggered) continue;
      if (pos.readyStep > step) {
        pending++;
        continue;
      }
      if (s * (mark - pos.liq) > 0) {
        // Price came back before the order landed; Perpl would refuse a liquidation above maintenance.
        pos.triggered = false;
        continue;
      }
      const bankrupt = s * (mark - pos.bank) <= 0;
      if (bankrupt && cfg.liquidation.bankruptPolicy === "adl") {
        // Perpl today: no margin left to sell, so it is deleveraged against winners at the mark.
        fill(pos, pos.remaining, mark, "gap", t, spot);
        continue;
      }
      // Fund first: a bankrupt position is taken on by the fund and sold at whatever the book pays.
      const path = bankrupt ? "system" : "book";
      const backstopPrice = mark * (1 - s * cfg.backstop.discount);
      const floorPrice = bankrupt ? spot * (1 - s * 0.95) : mark * (1 - s * cfg.liquidation.maxSlippage);
      const offsetOf = (price: number) => Math.abs(spot - price) / spot;
      const hasBuyer = backstopLeft > 0;

      // 1. The book, while it pays better than the backstop buyer would (or down to the floor).
      const firstLimit = hasBuyer ? Math.min(offsetOf(backstopPrice), offsetOf(floorPrice)) : offsetOf(floorPrice);
      let w = book.walk(pos.remaining, spot, firstLimit);
      if (w.filled > 0) {
        fill(pos, w.filled, w.notional / w.filled, path, t, spot);
      }
      // 2. The backstop buyer, while it has capacity.
      if (!pos.done && hasBuyer) {
        const size = Math.min(pos.remaining, backstopLeft / backstopPrice);
        if (size > 0) {
          backstopLeft -= size * backstopPrice;
          fill(pos, size, backstopPrice, "backstop", t, spot);
        }
      }
      // 3. If the buyer ran out, the rest of the book down to the floor.
      if (!pos.done && offsetOf(floorPrice) > firstLimit) {
        w = book.walk(pos.remaining, spot, offsetOf(floorPrice));
        if (w.filled > 0) {
          fill(pos, w.filled, w.notional / w.filled, path, t, spot);
        }
      }
      // Anything left waits for the book to refill, or for the mark to pass bankruptcy.
      if (!pos.done) pending++;
      mark = markOf();
    }

    const local = book.bookPrice(spot);
    totals.bookLow = down ? Math.min(totals.bookLow, local) : Math.max(totals.bookLow, local);
    if (record) {
      frames.push({
        t,
        spot,
        mark,
        bookPrice: local,
        fund,
        layerRemaining,
        badDebt: totals.badDebt,
        fundPaid: totals.fundPaid,
        layerPaid: totals.layerPaid,
        tradersLose: totals.tradersLose,
        liquidatedNotional: totals.liquidatedNotional,
        liquidations: totals.liquidations,
      });
    }
    totals.spotEnd = spot;
    totals.duration = t;
    step++;
    if (t >= pathEnd && (pending === 0 || t >= maxT)) break;
  }

  // Whatever the fund took on and could not sell before the run ended is valued at the last mark.
  if (cfg.liquidation.bankruptPolicy === "fund") {
    const lastMark = frames.length ? (frames[frames.length - 1] as Frame).mark : totals.spotEnd;
    for (const pos of positions) {
      if (pos.done || !pos.triggered || s * (lastMark - pos.bank) > 0) continue;
      fill(pos, pos.remaining, lastMark, "system", totals.duration, totals.spotEnd);
    }
    if (record && frames.length) {
      const f = frames[frames.length - 1] as Frame;
      Object.assign(f, {
        fund,
        layerRemaining,
        badDebt: totals.badDebt,
        fundPaid: totals.fundPaid,
        layerPaid: totals.layerPaid,
        tradersLose: totals.tradersLose,
        liquidatedNotional: totals.liquidatedNotional,
        liquidations: totals.liquidations,
      });
    }
  }

  totals.fundEnd = fund;
  totals.band = totals.tradersLose > 0 ? 3 : totals.layerPaid > 0 ? 2 : totals.badDebt > 0 ? 1 : 0;
  if (record) events.push({ t: totals.duration, kind: "settle" });

  return { kind: opts.kind, label: opts.label, direction: opts.direction, frames, events, totals };
}
