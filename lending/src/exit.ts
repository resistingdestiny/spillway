// Exit depth: how much of a collateral token liquidators can sell on Monad before the price they get
// eats the whole liquidation incentive.
//
// A liquidator repays debt and seizes collateral worth LIF times as much at the oracle. Selling it at a
// loss of more than 1 - 1/LIF against the oracle leaves them out of pocket, so they stop
// (docs/LENDING.md). The research quoted each token at $1k, $100k, $1M and $10M (docs/RESEARCH.md
// section 3). The depth for a market is the largest sale whose quoted loss stays within that market's
// 1 - 1/LIF. Between two quoted sizes the loss is taken as linear in the size, which is how an AMM's
// price impact grows for sales small against its reserves. Below the smallest quote nothing is assumed:
// if $1k already loses too much the depth is zero. Above the largest quote nothing is extrapolated.

import type { LendingConfig } from "./config.js";

/** Largest sale in USD whose loss against the reference stays within `maxLoss`. */
export function depthWithin(quotes: [number, number | null][], maxLoss: number): number {
  const pts = [...quotes].sort((a, b) => a[0] - b[0]).map(([size, vsRef]) => ({ size, loss: vsRef === null ? 1 : -vsRef }));
  const first = pts[0];
  if (!first || first.loss > maxLoss) return 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as { size: number; loss: number };
    const b = pts[i] as { size: number; loss: number };
    if (b.loss <= maxLoss) continue;
    return a.size + ((maxLoss - a.loss) / (b.loss - a.loss)) * (b.size - a.size);
  }
  return (pts[pts.length - 1] as { size: number }).size;
}

export interface ExitDepth {
  /** Where the depth comes from: the research's quotes, a config override, or nothing measured. */
  source: "quotes" | "override" | "unmeasured";
  /** The largest loss on the sale liquidators accept, 1 - 1/LIF. */
  maxLoss: number;
  /** USD of the token liquidators can sell in this market, null when unmeasured (no limit). */
  depthUsd: number | null;
}

/** Exit depth for one market, from its collateral token and its LIF. */
export function exitDepth(token: { address: string; symbol: string }, lif: number, cfg: LendingConfig): ExitDepth {
  const maxLoss = 1 - 1 / lif;
  const override = cfg.thinExit.exitDepthUsd[token.address];
  if (override !== undefined) return { source: "override", maxLoss, depthUsd: override };
  const quotes = cfg.thinExit.quotes[token.symbol];
  if (quotes) return { source: "quotes", maxLoss, depthUsd: depthWithin(quotes, maxLoss) };
  return { source: "unmeasured", maxLoss, depthUsd: null };
}
