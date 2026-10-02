// A small, made-up market for tests. Not Perpl data.

import { mulberry32 } from "../src/rng.js";
import type { BookLevel, Snapshot, SnapshotPosition } from "../src/types.js";

export interface SyntheticOptions {
  mark?: number;
  /** Dollars resting per 0.1% band on each side, out to `bookDepthPct`. */
  usdPerLevel?: number;
  bookDepthPct?: number;
  positions?: SnapshotPosition[];
  randomPositions?: number;
  insuranceFund?: number;
  seed?: number;
}

export function syntheticSnapshot(o: SyntheticOptions = {}): Snapshot {
  const mark = o.mark ?? 100_000;
  const usd = o.usdPerLevel ?? 20_000;
  const depth = o.bookDepthPct ?? 5;
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  for (let i = 1; i <= depth * 10; i++) {
    const off = i / 1000;
    bids.push([mark * (1 - off), usd / (mark * (1 - off)), 1]);
    asks.push([mark * (1 + off), usd / (mark * (1 + off)), 1]);
  }
  const positions: SnapshotPosition[] = [...(o.positions ?? [])];
  const rng = mulberry32(o.seed ?? 7);
  for (let i = 0; i < (o.randomPositions ?? 0); i++) {
    const lev = 2 + Math.floor(rng() * 14); // 2x to 15x
    const entry = mark * (0.97 + rng() * 0.06);
    const notional = 5_000 + rng() * 95_000;
    positions.push({
      accountId: 1000 + i,
      side: rng() < 0.5 ? "long" : "short",
      size: notional / entry,
      entryPrice: entry,
      deposit: notional / lev,
      premiumPnl: 0,
    });
  }
  const oi = (side: "long" | "short") => positions.filter((p) => p.side === side).reduce((a, p) => a + p.size, 0);
  return {
    schema: "spillway.snapshot/1",
    network: "synthetic",
    chainId: 0,
    block: 1,
    blockTimestamp: 1_790_000_000,
    takenAt: "2026-10-02T00:00:00Z",
    market: {
      perpId: 0,
      symbol: "BTC",
      priceDecimals: 1,
      lotDecimals: 5,
      markPrice: mark,
      oraclePrice: mark,
      lastPrice: mark,
      maintenanceMarginFraction: 0.04,
      initialMarginFraction: 1 / 15,
      longOpenInterest: oi("long"),
      shortOpenInterest: oi("short"),
      insuranceFund: o.insuranceFund ?? 50_000,
      liquidationSplit: { trader: 0.8, insurance: 0.1, protocol: 0.1 },
    },
    positions,
    book: { bids, asks },
  };
}

export const docsLong: SnapshotPosition = {
  accountId: 1,
  side: "long",
  size: 1,
  entryPrice: 100_000,
  deposit: 10_000,
  premiumPnl: 0,
};
