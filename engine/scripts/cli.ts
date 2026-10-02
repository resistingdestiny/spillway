// Command line for the engine.
//
//   tsx scripts/cli.ts stress <snapshot.json> [--move 0.1] [--layer 250000] [--backstop 250000] [--up]
//   tsx scripts/cli.ts curve  <snapshot.json> [--layer 250000] [--backstop 250000]
//   tsx scripts/cli.ts replay <snapshot.json> [--layer 250000] [--backstop 250000]
//   tsx scripts/cli.ts bundle <snapshot.json> --out <bundle.json> [--layer 250000] [--backstop 250000]
//
// `bundle` writes everything the web app needs that is too slow to compute in the browser.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ConfigOverrides,
  type DailyHistory,
  type PriceSeries,
  type RunTotals,
  type Snapshot,
  dailyMoves,
  depthWithin,
  ledges,
  leverage,
  monteCarlo,
  priceLayer,
  replay,
  smallestMoveReaching,
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

const history = JSON.parse(readFileSync(dataFile("btc-usd-daily.json"), "utf8")) as DailyHistory;
const crash = JSON.parse(readFileSync(dataFile("replay-2025-10-10.json"), "utf8")) as PriceSeries;

function summary() {
  const m = snapshot.market;
  const longs = snapshot.positions.filter((p) => p.side === "long");
  const shorts = snapshot.positions.filter((p) => p.side === "short");
  const notional = (ps: typeof longs) => ps.reduce((a, p) => a + p.entryPrice * p.size, 0);
  return {
    market: `${m.symbol} perp ${m.perpId} on ${snapshot.network}, block ${snapshot.block}`,
    mark: m.markPrice,
    insuranceFund: usd(m.insuranceFund),
    longs: `${longs.length} positions, ${usd(notional(longs))}`,
    shorts: `${shorts.length} positions, ${usd(notional(shorts))}`,
    maxLeverage: Math.max(0, ...snapshot.positions.map(leverage)).toFixed(1),
    bidDepth1pct: usd(depthWithin(snapshot, "bid", 0.01)),
    bidDepth5pct: usd(depthWithin(snapshot, "bid", 0.05)),
  };
}

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
    const curve = stressCurve(snapshot, cfg, "down");
    const moves = dailyMoves(history);
    const mc = monteCarlo(curve, moves.down, cfg, snapshot.market.insuranceFund, cfg.layer.limitUsd, moves);
    const replayRun = replay(snapshot, crash, cfg, { totalsOnly: true });
    const bundle = {
      schema: "spillway.bundle/1",
      generatedAt: new Date().toISOString(),
      snapshot: {
        network: snapshot.network,
        chainId: snapshot.chainId,
        block: snapshot.block,
        blockTimestamp: snapshot.blockTimestamp,
        takenAt: snapshot.takenAt,
        source: snapshot.source,
      },
      summary: summary(),
      config: cfg,
      ledges: { long: ledges(snapshot, cfg, { side: "long" }), short: ledges(snapshot, cfg, { side: "short" }) },
      curve: curve.map((p) => ({ move: p.move, totals: p.totals })),
      firstReaching: {
        fund: smallestMoveReaching(curve, 1)?.move ?? null,
        layer: smallestMoveReaching(curve, 2)?.move ?? null,
        traders: smallestMoveReaching(curve, 3)?.move ?? null,
      },
      replay: { label: crash.label, source: crash.source, totals: replayRun.totals },
      monteCarlo: mc,
      price: priceLayer(mc, cfg),
    };
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
