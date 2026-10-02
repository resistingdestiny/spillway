// Everything the web app needs that is too slow to compute in the browser, in one JSON file.

import { depthWithin } from "./book.js";
import type { EngineConfig } from "./config.js";
import { ledges } from "./ledges.js";
import { leverage } from "./margin.js";
import { type DailyHistory, dailyMoves, monteCarlo } from "./montecarlo.js";
import { priceLayer } from "./pricing.js";
import { type PriceSeries, replay, smallestMoveReaching, stressCurve } from "./runs.js";
import type { Snapshot } from "./types.js";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export function marketSummary(snapshot: Snapshot) {
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

export function buildBundle(snapshot: Snapshot, cfg: EngineConfig, history: DailyHistory, crash: PriceSeries) {
  const curve = stressCurve(snapshot, cfg, "down");
  const moves = dailyMoves(history);
  const mc = monteCarlo(curve, moves.down, cfg, snapshot.market.insuranceFund, cfg.layer.limitUsd, moves);
  const replayRun = replay(snapshot, crash, cfg, { totalsOnly: true });
  return {
    schema: "spillway.bundle/1" as const,
    generatedAt: new Date().toISOString(),
    snapshot: {
      network: snapshot.network,
      chainId: snapshot.chainId,
      block: snapshot.block,
      blockTimestamp: snapshot.blockTimestamp,
      takenAt: snapshot.takenAt,
      source: snapshot.source,
    },
    summary: marketSummary(snapshot),
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
}

export type Bundle = ReturnType<typeof buildBundle>;
