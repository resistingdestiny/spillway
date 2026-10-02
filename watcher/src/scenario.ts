// The scenarios the runner plays, and the engine run behind each one.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  type EngineConfig,
  type PriceSeries,
  type RunResult,
  type Snapshot,
  replay,
  scaleOpenInterest,
  stress,
} from "@spillway/engine";
import { REPO_DIR } from "./chain.js";

export const DEFAULT_SNAPSHOT = join(REPO_DIR, "fixtures", "snapshots", "btc-mainnet.json");
export const REPLAY_SERIES = join(REPO_DIR, "engine", "data", "replay-2025-10-10.json");

export interface ScenarioSpec {
  name: string;
  label: string;
  /** Multiple of today's open interest (engine scaleOpenInterest). */
  oiMultiple: number;
  /** Stress drop as a fraction. Leave out to replay 10 October 2025. */
  drop?: number;
  /** Which band the engine should reach: 1 fund, 2 layer, 3 traders. A check, not an input. */
  expectBand?: 0 | 1 | 2 | 3;
}

/**
 * The three outcomes on the real mainnet snapshot, default engine config. The drops come from
 * the engine's stress curve: at 10x open interest the layer first pays at a 16% drop and is used
 * up at 21%.
 */
export const SCENARIOS: ScenarioSpec[] = [
  { name: "oi1x-drop20", label: "Today's open interest, 20% drop", oiMultiple: 1, drop: 0.2, expectBand: 1 },
  { name: "oi10x-drop20", label: "10x open interest, 20% drop", oiMultiple: 10, drop: 0.2, expectBand: 2 },
  { name: "oi10x-drop25", label: "10x open interest, 25% drop", oiMultiple: 10, drop: 0.25, expectBand: 3 },
];

export function findScenario(name: string): ScenarioSpec {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown scenario ${name}; known: ${SCENARIOS.map((x) => x.name).join(", ")}`);
  return s;
}

/** A scenario from flags: `--oi 10 --drop 0.2`, or `--oi 10` alone for the replay. */
export function adhocScenario(oiMultiple: number, drop?: number): ScenarioSpec {
  const what = drop === undefined ? "10 Oct 2025 replay" : `${+(drop * 100).toFixed(2)}% drop`;
  const name = `oi${oiMultiple}x-${drop === undefined ? "replay" : `drop${+(drop * 100).toFixed(2)}`}`;
  return { name, label: `${oiMultiple}x open interest, ${what}`, oiMultiple, drop };
}

export function loadSnapshot(path = DEFAULT_SNAPSHOT): Snapshot {
  return JSON.parse(readFileSync(path, "utf8")) as Snapshot;
}

/** What the chain holds at the start of a run. The engine starts from the same place. */
export interface Calibration {
  /** Insurance fund on the adapter, in dollars. */
  fundUsd: number;
  /** What the vault can still pay, in dollars. */
  layerUsd: number;
}

/**
 * Runs the engine for a scenario. With a calibration, the fund and the layer start where the
 * chain has them, so a run on a fresh deploy uses the snapshot's fund and the config's limit,
 * and a later run on testnet uses what earlier runs left.
 */
export function runEngine(snapshot: Snapshot, spec: ScenarioSpec, cfg: EngineConfig = DEFAULT_CONFIG, cal?: Calibration): RunResult {
  let snap = scaleOpenInterest(snapshot, spec.oiMultiple);
  if (cal) snap = { ...snap, market: { ...snap.market, insuranceFund: cal.fundUsd } };
  const layerLimitUsd = cal?.layerUsd;
  if (spec.drop === undefined) {
    const series = JSON.parse(readFileSync(REPLAY_SERIES, "utf8")) as PriceSeries;
    return replay(snap, series, cfg, { layerLimitUsd });
  }
  return stress(snap, spec.drop, cfg, { layerLimitUsd });
}
