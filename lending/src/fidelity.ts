// Checks that the model reads the snapshot the way Morpho does, before any number is built on it.
//
// 1. Health factor. Morpho Blue holds a borrower healthy while
//      collateral * price / 1e36 * lltv / 1e18 >= borrowAssets
//    so the health factor is the left side over the right. We recompute it from the raw amounts and
//    compare it with the API's `healthFactor` for every borrower.
// 2. Totals. Each market's positions should add up to the market's own `state` totals.

import { type LendingBook, type Market, type Position, positionsByMarket, units } from "./snapshot.js";

/** Collateral value in whole loan tokens at the oracle price. */
export function collateralValue(m: Market, p: Position): number {
  if (!m.collateral || m.price === null) return 0;
  return units(p.collateral, m.collateral.decimals) * m.price;
}

/** Borrowed amount in whole loan tokens. */
export const debt = (m: Market, p: Position): number => units(p.borrowAssets, m.loan.decimals);

/** Morpho's health factor at the oracle price, or null for a position with no borrow. */
export function healthFactor(m: Market, p: Position): number | null {
  if (p.borrowAssets === 0n) return null;
  return (collateralValue(m, p) * m.lltv) / debt(m, p);
}

export interface HealthCheck {
  marketId: string;
  user: string;
  ours: number;
  api: number;
  /** ours / api - 1 */
  gap: number;
}

export interface MarketHealthCheck {
  marketId: string;
  borrowers: number;
  /** Mean of ours / api - 1 over the market's borrowers. */
  offset: number;
  /** Largest minus smallest gap within the market. Near zero means any offset is the market's, not a position's. */
  spread: number;
}

export function checkHealthFactors(book: LendingBook): { rows: HealthCheck[]; markets: MarketHealthCheck[]; missing: number } {
  const byId = new Map(book.markets.map((m) => [m.id, m]));
  const rows: HealthCheck[] = [];
  let missing = 0;
  for (const p of book.positions) {
    const m = byId.get(p.marketId) as Market;
    const ours = healthFactor(m, p);
    if (ours === null) continue;
    if (p.apiHealthFactor === null) {
      missing++;
      continue;
    }
    rows.push({ marketId: m.id, user: p.user, ours, api: p.apiHealthFactor, gap: ours / p.apiHealthFactor - 1 });
  }
  const groups = new Map<string, HealthCheck[]>();
  for (const r of rows) groups.set(r.marketId, [...(groups.get(r.marketId) ?? []), r]);
  const markets = [...groups].map(([marketId, rs]) => {
    const gaps = rs.map((r) => r.gap);
    return {
      marketId,
      borrowers: rs.length,
      offset: gaps.reduce((a, g) => a + g, 0) / gaps.length,
      spread: Math.max(...gaps) - Math.min(...gaps),
    };
  });
  return { rows, markets, missing };
}

export type TotalField = "supplyAssets" | "supplyShares" | "borrowAssets" | "borrowShares" | "collateral";
export const TOTAL_FIELDS: TotalField[] = ["supplyAssets", "supplyShares", "borrowAssets", "borrowShares", "collateral"];

export interface TotalsCheck {
  marketId: string;
  field: TotalField;
  positions: bigint;
  state: bigint;
  /** |positions - state| / max(positions, state), 0 when both are 0. */
  gap: number;
}

export function reconcileTotals(book: LendingBook): TotalsCheck[] {
  const groups = positionsByMarket(book);
  const out: TotalsCheck[] = [];
  for (const m of book.markets) {
    const ps = groups.get(m.id) ?? [];
    for (const field of TOTAL_FIELDS) {
      const sum = ps.reduce((a, p) => a + p[field], 0n);
      const state = m.totals[field];
      const hi = sum > state ? sum : state;
      const diff = sum > state ? sum - state : state - sum;
      out.push({ marketId: m.id, field, positions: sum, state, gap: hi === 0n ? 0 : Number(diff) / Number(hi) });
    }
  }
  return out;
}
