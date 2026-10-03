// The kinds of run the app shows: one stress drop, the stress curve, and a replay of a past crash.

import { simulate } from "./cascade.js";
import type { EngineConfig } from "./config.js";
import type { PricePath, RunResult, RunTotals, Snapshot } from "./types.js";

/** Spot falls (or rises) linearly to the chosen move, then holds. */
export function stressPath(move: number, cfg: EngineConfig, direction: "down" | "up" = "down"): PricePath {
  const target = direction === "down" ? 1 - move : 1 + move;
  const { shockSeconds, holdSeconds } = cfg.stress;
  return { t: [0, shockSeconds, shockSeconds + holdSeconds], ratio: [1, target, target] };
}

export interface StressOptions {
  direction?: "down" | "up";
  totalsOnly?: boolean;
  layerLimitUsd?: number;
}

export function stress(snapshot: Snapshot, move: number, cfg: EngineConfig, opts: StressOptions = {}): RunResult {
  const direction = opts.direction ?? "down";
  return simulate(snapshot, cfg, {
    kind: "stress",
    label: `${direction === "down" ? "Drop" : "Rise"} of ${(move * 100).toFixed(1)}%`,
    direction,
    path: stressPath(move, cfg, direction),
    totalsOnly: opts.totalsOnly,
    layerLimitUsd: opts.layerLimitUsd,
  });
}

/** A gap: the price falls while liquidations are paused, then holds. */
export function gapPath(move: number, cfg: EngineConfig, direction: "down" | "up" = "down"): PricePath {
  const target = direction === "down" ? 1 - move : 1 + move;
  const { seconds } = cfg.gap;
  return { t: [0, seconds, seconds + cfg.stress.holdSeconds], ratio: [1, target, target] };
}

export function gap(snapshot: Snapshot, move: number, cfg: EngineConfig, opts: StressOptions = {}): RunResult {
  const direction = opts.direction ?? "down";
  return simulate(snapshot, cfg, {
    kind: "gap",
    label: `Gap of ${(move * 100).toFixed(1)}% while liquidations are paused`,
    direction,
    path: gapPath(move, cfg, direction),
    totalsOnly: opts.totalsOnly,
    layerLimitUsd: opts.layerLimitUsd,
  });
}

export interface StressPoint {
  move: number;
  totals: RunTotals;
}

/** Totals for every move on the stress grid. Feeds the Monte Carlo and the slider's lookup. */
export function stressCurve(snapshot: Snapshot, cfg: EngineConfig, direction: "down" | "up" = "down"): StressPoint[] {
  return cfg.stressGrid.map((move) => ({
    move,
    totals: stress(snapshot, move, cfg, { direction, totalsOnly: true }).totals,
  }));
}

/** Totals for a gap of every size on the stress grid. */
export function gapCurve(snapshot: Snapshot, cfg: EngineConfig, direction: "down" | "up" = "down"): StressPoint[] {
  return cfg.stressGrid.map((move) => ({
    move,
    totals: gap(snapshot, move, cfg, { direction, totalsOnly: true }).totals,
  }));
}

/**
 * The smallest move on the grid whose water reaches `band` (1 fund, 2 layer, 3 traders), or null.
 * The demo falls back to this when a replay on today's book stays below the layer.
 */
export function smallestMoveReaching(curve: StressPoint[], band: 1 | 2 | 3): StressPoint | null {
  return curve.find((p) => p.totals.band >= band) ?? null;
}

/** A historical price series: unix seconds and prices. */
export interface PriceSeries {
  label: string;
  source: string;
  t: number[];
  /** One price per timestamp, or open/low/high/close candles. */
  price?: number[];
  candles?: { open: number; high: number; low: number; close: number }[];
}

/**
 * Turn a price series into a relative path that starts at 1. Candles are walked open, extreme, close,
 * taking the low first on a fall and the high first on a rise, so wicks are kept.
 */
export function seriesToPath(series: PriceSeries, direction: "down" | "up" = "down"): PricePath {
  const t0 = series.t[0] ?? 0;
  const t: number[] = [];
  const raw: number[] = [];
  if (series.candles) {
    series.candles.forEach((c, i) => {
      const start = (series.t[i] as number) - t0;
      const next = i + 1 < series.t.length ? (series.t[i + 1] as number) - t0 : start + 60;
      const span = next - start;
      const extreme = direction === "down" ? c.low : c.high;
      t.push(start, start + span / 2, start + span * 0.999);
      raw.push(c.open, extreme, c.close);
    });
  } else if (series.price) {
    series.price.forEach((p, i) => {
      t.push((series.t[i] as number) - t0);
      raw.push(p);
    });
  }
  const base = raw[0] ?? 1;
  return { t, ratio: raw.map((p) => p / base) };
}

export function replay(snapshot: Snapshot, series: PriceSeries, cfg: EngineConfig, opts: StressOptions = {}): RunResult {
  const direction = opts.direction ?? "down";
  return simulate(snapshot, cfg, {
    kind: "replay",
    label: series.label,
    direction,
    path: seriesToPath(series, direction),
    totalsOnly: opts.totalsOnly,
    layerLimitUsd: opts.layerLimitUsd,
  });
}
