// Perpl's published liquidation maths (docs.perpl.xyz/exchange/liquidation).
//
//   MMR            = P_entry * L * maintenance margin fraction
//   P_liquidation  = P_entry + s * (MMR - deposit - funding) / L
//   P_bankruptcy   = P_entry - s * (deposit + funding) / L
//
// s is +1 for a long and -1 for a short. "funding" is the position's premium PnL, signed,
// which is how the Perpl SDK applies it (Position::liquidation_price, bankruptcy_price).

import type { Side, SnapshotPosition } from "./types.js";

export const sign = (side: Side): 1 | -1 => (side === "long" ? 1 : -1);

export function maintenanceRequirement(p: SnapshotPosition, mmFraction: number): number {
  return p.entryPrice * p.size * mmFraction;
}

export function liquidationPrice(p: SnapshotPosition, mmFraction: number): number {
  const s = sign(p.side);
  const price = p.entryPrice + (s * (maintenanceRequirement(p, mmFraction) - p.deposit - p.premiumPnl)) / p.size;
  return Math.max(0, price);
}

export function bankruptcyPrice(p: SnapshotPosition): number {
  const s = sign(p.side);
  return Math.max(0, p.entryPrice - (s * (p.deposit + p.premiumPnl)) / p.size);
}

/** Margin left in the position if `size` units of it close at `price`. Negative means bad debt. */
export function equityAt(p: SnapshotPosition, price: number, size: number = p.size): number {
  const share = size / p.size;
  return (p.deposit + p.premiumPnl) * share + sign(p.side) * size * (price - p.entryPrice);
}

/** True when the mark has reached the liquidation price: 0 < FMV <= MMR in Perpl's terms. */
export function isLiquidatable(p: SnapshotPosition, mark: number, mmFraction: number): boolean {
  return sign(p.side) * (mark - liquidationPrice(p, mmFraction)) <= 0;
}

/** True when the position has no value left at this price (FMV <= 0). */
export function isBankrupt(p: SnapshotPosition, price: number): boolean {
  return sign(p.side) * (price - bankruptcyPrice(p)) <= 0;
}

export interface ResidualSplit {
  trader: number;
  insurance: number;
  protocol: number;
}

/** How Perpl splits the margin left after a liquidation. Default 80 / 10 / 10. */
export function splitResidual(residual: number, split: ResidualSplit): ResidualSplit {
  const r = Math.max(0, residual);
  return { trader: r * split.trader, insurance: r * split.insurance, protocol: r * split.protocol };
}

/** Leverage implied by the margin posted at entry. */
export function leverage(p: SnapshotPosition): number {
  return (p.entryPrice * p.size) / p.deposit;
}
