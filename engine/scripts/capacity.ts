// How far can open interest grow before the insurance fund alone stops being enough?
// For each multiple of today's open interest: the yearly chance that losses beyond traders' margin
// empty the fund, with no layer and with the Spillway layer, and the layer's price.
//
//   tsx scripts/capacity.ts <snapshot.json> [--out capacity.json]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type WorstHourHistory,
  type Snapshot,
  worstHourMoves,
  monteCarlo,
  priceLayer,
  scaleOpenInterest,
  stressCurve,
  withConfig,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const [snapshotPath, ...rest] = process.argv.slice(2);
if (!snapshotPath) throw new Error("usage: capacity.ts <snapshot.json> [--out file]");
const outIdx = rest.indexOf("--out");
const out = outIdx >= 0 ? rest[outIdx + 1] : undefined;

const today = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
const history = JSON.parse(readFileSync(join(here, "..", "data", "btc-usd-worst-hour.json"), "utf8")) as WorstHourHistory;
const moves = worstHourMoves(history);
const cfg = withConfig();
const fund = today.market.insuranceFund;
const limit = cfg.layer.limitUsd;
const oiToday = today.positions.filter((p) => p.side === "long").reduce((a, p) => a + p.entryPrice * p.size, 0);

const rows = [1, 2, 3, 5, 10, 20, 30].map((k) => {
  const snap = scaleOpenInterest(today, k);
  const curve = stressCurve(snap, cfg);
  const mc = monteCarlo(curve, moves.down, cfg, fund, limit, moves);
  const price = priceLayer(mc, cfg);
  // Without a layer, everything past the fund lands on traders: that is the chance the fund runs dry.
  const firstPastFund = curve.find((p) => p.totals.badDebt > p.totals.fundStart + p.totals.fundIncome);
  const firstPastLayer = curve.find((p) => p.totals.tradersLose > 0);
  return {
    multiple: k,
    longOpenInterest: oiToday * k,
    fundRunsDryPerYear: mc.pLayer + (mc.pTraders > mc.pLayer ? mc.pTraders - mc.pLayer : 0),
    tradersHitWithLayerPerYear: mc.pTraders,
    expectedLayerLossPerYear: mc.expected.layerPaid,
    layerRate: price.rate,
    layerPremiumPerYear: price.annualPremium,
    smallestDropPastFund: firstPastFund?.move ?? null,
    smallestDropPastLayer: firstPastLayer?.move ?? null,
  };
});

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
console.table(
  rows.map((r) => ({
    OI: `${r.multiple}x ($${(r.longOpenInterest / 1e6).toFixed(1)}M)`,
    "fund dry / yr": pct(r.fundRunsDryPerYear),
    "traders hit / yr (with layer)": pct(r.tradersHitWithLayerPerYear),
    "drop past fund": r.smallestDropPastFund === null ? "> 40%" : pct(r.smallestDropPastFund),
    "drop past layer": r.smallestDropPastLayer === null ? "> 40%" : pct(r.smallestDropPastLayer),
    "layer rate": pct(r.layerRate),
    "premium / yr": `$${Math.round(r.layerPremiumPerYear).toLocaleString("en-US")}`,
  })),
);
if (out) writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), fund, limit, config: cfg, rows }, null, 2) + "\n");
