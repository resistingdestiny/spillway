// Command line for the engine.
//
//   tsx scripts/cli.ts stress <snapshot.json> [--move 0.1] [--layer 250000] [--backstop 250000] [--up]
//   tsx scripts/cli.ts curve  <snapshot.json> [--layer 250000] [--backstop 250000]
//   tsx scripts/cli.ts replay <snapshot.json> [--layer 250000] [--backstop 250000]
//   tsx scripts/cli.ts bundle <snapshot.json> --out <bundle.json> [--layer 250000] [--backstop 250000]
//
// `bundle` writes everything the web app needs that is too slow to compute in the browser.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ConfigOverrides,
  type WorstHourHistory,
  type PriceSeries,
  type RunTotals,
  type Snapshot,
  type WorstMinuteHistory,
  buildBundle,
  marketSummary,
  replay,
  stress,
  stressCurve,
  withConfig,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataFile = (name: string) => join(here, "..", "data", name);

const [command, snapshotPath, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (name: string) => rest.includes(`--${name}`);

if (!command || !snapshotPath) {
  console.error("usage: cli.ts <stress|curve|replay|bundle> <snapshot.json> [options]");
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
const overrides: ConfigOverrides = {};
if (flag("layer")) overrides.layer = { limitUsd: Number(flag("layer")) };
if (flag("backstop")) overrides.backstop = { capacityUsd: Number(flag("backstop")) };
const cfg = withConfig(overrides);
const direction = has("up") ? "up" : "down";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const row = (t: RunTotals) => ({
  badDebt: usd(t.badDebt),
  fund: usd(t.fundPaid),
  layer: usd(t.layerPaid),
  traders: usd(t.tradersLose),
  liqs: t.liquidations,
  liquidated: usd(t.liquidatedNotional),
  bookLow: Math.round(t.bookLow),
  band: t.band,
});

const history = JSON.parse(readFileSync(dataFile("btc-usd-worst-hour.json"), "utf8")) as WorstHourHistory;
const crash = JSON.parse(readFileSync(dataFile("replay-2025-10-10.json"), "utf8")) as PriceSeries;
const minutesFile = dataFile("btc-usd-worst-minute.json");
const minutes = existsSync(minutesFile) ? (JSON.parse(readFileSync(minutesFile, "utf8")) as WorstMinuteHistory) : undefined;

const summary = () => marketSummary(snapshot);

switch (command) {
  case "stress": {
    const move = Number(flag("move") ?? 0.1);
    console.table(summary());
    console.table(row(stress(snapshot, move, cfg, { direction }).totals));
    break;
  }
  case "curve": {
    console.table(summary());
    const curve = stressCurve(snapshot, cfg, direction);
    console.table(curve.filter((_, i) => i % 4 === 3).map((p) => ({ move: `${(p.move * 100).toFixed(1)}%`, ...row(p.totals) })));
    break;
  }
  case "replay": {
    console.table(summary());
    console.table(row(replay(snapshot, crash, cfg).totals));
    break;
  }
  case "bundle": {
    const out = flag("out");
    if (!out) throw new Error("--out is required");
    const t0 = Date.now();
    const bundle = buildBundle(snapshot, cfg, history, crash, minutes);
    const mc = bundle.monteCarlo;
    writeFileSync(out, JSON.stringify(bundle) + "\n");
    console.error(`bundle written to ${out} in ${Date.now() - t0} ms`);
    console.table(summary());
    console.table({ ...bundle.firstReaching, pFund: mc.pFund, pLayer: mc.pLayer, pTraders: mc.pTraders, rate: bundle.price.rate });
    break;
  }
  default:
    console.error(`unknown command ${command}`);
    process.exit(1);
}
