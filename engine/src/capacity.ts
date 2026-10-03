// How much open interest can a fund carry?
//
// For a gap of a given size, find the largest multiple of today's positions whose losses beyond
// traders' margin are still paid in full: by the fund alone, or by the fund and the Spillway layer.
// "Paid in full" means no winning trader is left short. Positions are scaled with
// scaleOpenInterest, so leverage and liquidation prices stay as they are today and the book does not
// grow.

import type { EngineConfig } from "./config.js";
import { gap } from "./runs.js";
import { scaleOpenInterest } from "./scenario.js";
import type { Snapshot } from "./types.js";

export interface Capacity {
  /** Size of the gap, as a fraction. */
  gap: number;
  /** Largest safe multiple of today's open interest. */
  factor: number;
  /** Long open interest at that multiple, in dollars at entry. */
  openInterest: number;
  /** True when even the largest multiple searched is safe. */
  atSearchLimit: boolean;
}

const longNotional = (s: Snapshot) => s.positions.filter((p) => p.side === "long").reduce((a, p) => a + p.entryPrice * p.size, 0);

function safe(snapshot: Snapshot, factor: number, move: number, cfg: EngineConfig, layerLimitUsd: number): boolean {
  const totals = gap(scaleOpenInterest(snapshot, factor), move, cfg, { totalsOnly: true, layerLimitUsd }).totals;
  return totals.tradersLose <= 1e-6;
}

/** Largest safe multiple by bisection. Losses grow with open interest, so safety only fails once. */
export function safeOpenInterest(snapshot: Snapshot, move: number, cfg: EngineConfig, withLayer: boolean): Capacity {
  const layer = withLayer ? cfg.layer.limitUsd : 0;
  const max = cfg.capacity.maxFactor;
  const today = longNotional(snapshot);
  if (safe(snapshot, max, move, cfg, layer)) return { gap: move, factor: max, openInterest: today * max, atSearchLimit: true };
  let lo = 0;
  let hi = max;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (safe(snapshot, mid, move, cfg, layer)) lo = mid;
    else hi = mid;
  }
  return { gap: move, factor: lo, openInterest: today * lo, atSearchLimit: false };
}

export interface CapacityRow {
  gap: number;
  fundOnly: Capacity;
  withSpillway: Capacity;
}

export function capacityTable(snapshot: Snapshot, cfg: EngineConfig, gaps: number[]): CapacityRow[] {
  return gaps.map((g) => ({
    gap: g,
    fundOnly: safeOpenInterest(snapshot, g, cfg, false),
    withSpillway: safeOpenInterest(snapshot, g, cfg, true),
  }));
}
