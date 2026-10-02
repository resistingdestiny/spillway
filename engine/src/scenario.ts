// Scenarios built from a real snapshot.

import type { Snapshot } from "./types.js";

/**
 * Today's positions, each scaled by `factor`: same entry prices, leverage and liquidation prices, more
 * money at each. The order book is left as it is, on the assumption that depth does not grow as fast
 * as open interest. Perpl caps BTC open interest at 300 BTC (getMarginFractions oiMaxLNS), about 30
 * times its size on 2 October 2026, so factors up to that are inside what the exchange already allows.
 */
export function scaleOpenInterest(snapshot: Snapshot, factor: number): Snapshot {
  if (factor === 1) return snapshot;
  return {
    ...snapshot,
    market: {
      ...snapshot.market,
      longOpenInterest: snapshot.market.longOpenInterest * factor,
      shortOpenInterest: snapshot.market.shortOpenInterest * factor,
    },
    positions: snapshot.positions.map((p) => ({
      ...p,
      size: p.size * factor,
      deposit: p.deposit * factor,
      premiumPnl: p.premiumPnl * factor,
      deltaPnl: p.deltaPnl === undefined ? undefined : p.deltaPnl * factor,
    })),
  };
}
