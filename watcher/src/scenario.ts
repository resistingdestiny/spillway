// The scenarios the runner plays, and the engine run behind each one.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ConfigOverrides,
  DEFAULT_CONFIG,
  type EngineConfig,
  type PriceSeries,
  type RunResult,
  type Snapshot,
  replay,
  scaleOpenInterest,
  stress,
  withConfig,
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
  /** Changes to the engine's default config for this scenario. Leave out for the defaults. */
  config?: ConfigOverrides;
  /** Which band the engine should reach: 1 fund, 2 layer, 3 traders. A check, not an input. */
  expectBand?: 0 | 1 | 2 | 3;
}

/** An instant gap: spot reaches the drop in one second, so positions pass bankruptcy before they can be sold. */
export const GAP: ConfigOverrides = { stress: { shockSeconds: 1 } };

/**
 * The three outcomes on the real mainnet snapshot. The drops come from the engine's stress curve.
 * Under the default config (Perpl's ADL order, a 10 minute fall) the fund covers every drop up to
 * 40% even at 30x today's open interest, so the layer and traders scenarios use an instant gap
 * (shockSeconds 1, everything else default). At 10x open interest with a gap, the layer first pays
 * at a 16% drop and is used up at 20%.
 */
export const SCENARIOS: ScenarioSpec[] = [
  { name: "oi1x-drop20", label: "Today's open interest, 20% fall over 10 minutes", oiMultiple: 1, drop: 0.2, expectBand: 1 },
  { name: "oi10x-gap18", label: "10x open interest, instant 18% gap", oiMultiple: 10, drop: 0.18, config: GAP, expectBand: 2 },
  { name: "oi10x-gap25", label: "10x open interest, instant 25% gap", oiMultiple: 10, drop: 0.25, config: GAP, expectBand: 3 },
];

export function findScenario(name: string): ScenarioSpec {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown scenario ${name}; known: ${SCENARIOS.map((x) => x.name).join(", ")}`);
  return s;
}

/** A scenario from flags: `--oi 10 --drop 0.2 [--gap]`, or `--oi 10` alone for the replay. */
export function adhocScenario(oiMultiple: number, drop?: number, gap = false): ScenarioSpec {
  const pct = drop === undefined ? "" : `${+(drop * 100).toFixed(2)}`;
  const what = drop === undefined ? "10 Oct 2025 replay" : gap ? `instant ${pct}% gap` : `${pct}% fall`;
  const name = `oi${oiMultiple}x-${drop === undefined ? "replay" : `${gap ? "gap" : "drop"}${pct}`}`;
  return { name, label: `${oiMultiple}x open interest, ${what}`, oiMultiple, drop, ...(gap ? { config: GAP } : {}) };
}

export function loadSnapshot(path = DEFAULT_SNAPSHOT): Snapshot {
  return JSON.parse(readFileSync(path, "utf8")) as Snapshot;
}

/** "default", or "default + stress.shockSeconds=1" for a scenario with overrides. */
export function configLabel(spec: ScenarioSpec): string {
  if (!spec.config) return "default";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(spec.config)) {
    if (v && typeof v === "object" && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) parts.push(`${k}.${k2}=${String(v2)}`);
    else parts.push(`${k}=${String(v)}`);
  }
  return `default + ${parts.join(", ")}`;
}

/** The engine config a scenario runs with: the base (the defaults) plus its own overrides. */
export function scenarioConfig(spec: ScenarioSpec, base: EngineConfig = DEFAULT_CONFIG): EngineConfig {
  return spec.config ? withConfig(spec.config, base) : base;
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
export function runEngine(snapshot: Snapshot, spec: ScenarioSpec, base: EngineConfig = DEFAULT_CONFIG, cal?: Calibration): RunResult {
  const cfg = scenarioConfig(spec, base);
  let snap = scaleOpenInterest(snapshot, spec.oiMultiple);
  if (cal) snap = { ...snap, market: { ...snap.market, insuranceFund: cal.fundUsd } };
  const layerLimitUsd = cal?.layerUsd;
  if (spec.drop === undefined) {
    const series = JSON.parse(readFileSync(REPLAY_SERIES, "utf8")) as PriceSeries;
    return replay(snap, series, cfg, { layerLimitUsd });
  }
  return stress(snap, spec.drop, cfg, { layerLimitUsd });
}
