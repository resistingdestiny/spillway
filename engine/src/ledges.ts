// The cliff: open positions grouped by the price at which they liquidate.
// Each ledge holds the positions that liquidate inside one price band; its width is their size.

import type { EngineConfig } from "./config.js";
import { bankruptcyPrice, liquidationPrice } from "./margin.js";
import type { Side, Snapshot } from "./types.js";

export interface Ledge {
  side: Side;
  /** Price band, as prices. For longs `from` is the higher edge. */
  from: number;
  to: number;
  /** Size-weighted average liquidation price of the positions on the ledge. */
  price: number;
  /** Distance from the mark to `price`, as a fraction. */
  distance: number;
  /** Dollars of position at entry. */
  notional: number;
  size: number;
  positions: number;
  /** Margin posted by these positions. */
  margin: number;
  /** Size-weighted average bankruptcy price. */
  bankruptcy: number;
  accountIds: number[];
}

export interface LedgeOptions {
  side?: Side;
  /** Band height as a fraction of the mark. */
  bucket?: number;
  /** Ignore positions that liquidate further than this from the mark. */
  maxDistance?: number;
}

export function ledges(snapshot: Snapshot, _cfg: EngineConfig, opts: LedgeOptions = {}): Ledge[] {
  const side = opts.side ?? "long";
  const bucket = opts.bucket ?? 0.005;
  const maxDistance = opts.maxDistance ?? 0.4;
  const mark = snapshot.market.markPrice;
  const mm = snapshot.market.maintenanceMarginFraction;
  const dir = side === "long" ? 1 : -1;

  const groups = new Map<number, Ledge>();
  for (const p of snapshot.positions) {
    if (p.side !== side || p.size <= 0) continue;
    const liq = liquidationPrice(p, mm);
    const distance = Math.max(0, (dir * (mark - liq)) / mark);
    if (distance > maxDistance) continue;
    const k = Math.floor(distance / bucket);
    let g = groups.get(k);
    if (!g) {
      g = {
        side,
        from: mark * (1 - dir * k * bucket),
        to: mark * (1 - dir * (k + 1) * bucket),
        price: 0,
        distance: 0,
        notional: 0,
        size: 0,
        positions: 0,
        margin: 0,
        bankruptcy: 0,
        accountIds: [],
      };
      groups.set(k, g);
    }
    g.price += liq * p.size;
    g.bankruptcy += bankruptcyPrice(p) * p.size;
    g.size += p.size;
    g.notional += p.entryPrice * p.size;
    g.margin += p.deposit;
    g.positions += 1;
    g.accountIds.push(p.accountId);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, g]) => {
      const price = g.price / g.size;
      return { ...g, price, bankruptcy: g.bankruptcy / g.size, distance: (dir * (mark - price)) / mark };
    });
}
