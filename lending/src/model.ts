// One Morpho Blue position under a shock, as docs/LENDING.md sets out.
//
// A borrower is liquidatable once collateral * oraclePrice * LLTV < debt. A liquidator repays debt
// and seizes collateral worth the repaid amount times the liquidation incentive factor (LIF), at the
// oracle price. Morpho Blue liquidations have no close factor: one call can repay the whole debt. If
// the collateral runs out first, Morpho writes the rest of the debt off at once (bad debt, realised).
// A partial liquidation that leaves collateral behind realises nothing.
//
// All amounts here are in whole loan tokens. Values are at two prices: the oracle's, which Morpho
// uses to decide and settle liquidations, and the market's, what the collateral would really fetch.
// They differ only in the hidden loss scenario, where the oracle does not follow the market.

import type { LendingConfig } from "./config.js";

/** Morpho Blue: LIF = min(1.15, 1 / (1 - 0.3 * (1 - LLTV))). */
export function liquidationIncentive(lltv: number, cfg: LendingConfig): number {
  const { liquidationCursor, maxLiquidationIncentive } = cfg.morpho;
  return Math.min(maxLiquidationIncentive, 1 / (1 - liquidationCursor * (1 - lltv)));
}

export type Outcome =
  /** Not liquidatable, and the collateral covers the debt at the market price. */
  | "healthy"
  /** Liquidated in full, the collateral covered the debt plus the incentive. No loss. */
  | "liquidated"
  /** Liquidated in full, the collateral ran out: the shortfall is written off now. */
  | "bad-debt"
  /** Not liquidated, or only in part: the shortfall at the market price is a loss not yet realised. */
  | "unrealised";

export interface PositionInput {
  /** Borrowed, in loan tokens. */
  debt: number;
  /** Collateral value at the oracle price, in loan tokens. */
  oracleValue: number;
  /** Collateral value at the market price, in loan tokens. */
  marketValue: number;
  lltv: number;
  lif: number;
  /**
   * Share of the full liquidation that liquidators can carry out, 0 to 1. 1 is "liquidators always
   * act". Less than 1 is the thin exit: they stop where selling the seized collateral would cost more
   * than the incentive pays.
   */
  fill: number;
}

export interface PositionResult {
  outcome: Outcome;
  liquidatable: boolean;
  /** Debt repaid by liquidators. */
  repaid: number;
  /** Collateral seized, at the oracle price. */
  seized: number;
  /** Loss written off by Morpho now. */
  realised: number;
  /** Loss that suppliers carry but Morpho has not written off. */
  unrealised: number;
}

const none = (outcome: Outcome, liquidatable: boolean, unrealised = 0): PositionResult => ({
  outcome,
  liquidatable,
  repaid: 0,
  seized: 0,
  realised: 0,
  unrealised,
});

export function positionOutcome(p: PositionInput): PositionResult {
  if (p.debt <= 0) return none("healthy", false);
  const liquidatable = p.oracleValue * p.lltv < p.debt;
  const shortfall = Math.max(0, p.debt - p.marketValue);
  if (!liquidatable) return shortfall > 0 ? none("unrealised", false, shortfall) : none("healthy", false);
  // A liquidator pays debt at the oracle and sells at the market. Below this they lose money and wait.
  const profitable = p.oracleValue === 0 || (p.marketValue / p.oracleValue) * p.lif > 1;
  const fill = profitable ? Math.min(1, Math.max(0, p.fill)) : 0;
  const seizedFull = Math.min(p.oracleValue, p.debt * p.lif);
  const repaidFull = seizedFull / p.lif;
  if (fill === 1) {
    if (repaidFull >= p.debt) return { outcome: "liquidated", liquidatable, repaid: p.debt, seized: seizedFull, realised: 0, unrealised: 0 };
    return { outcome: "bad-debt", liquidatable, repaid: repaidFull, seized: seizedFull, realised: p.debt - repaidFull, unrealised: 0 };
  }
  // Part or none of it: what is left owes debt - repaid against collateral worth marketValue - seized.
  const repaid = fill * repaidFull;
  const seized = fill * seizedFull;
  const leftValue = p.oracleValue > 0 ? p.marketValue * (1 - seized / p.oracleValue) : 0;
  const unrealised = Math.max(0, p.debt - repaid - leftValue);
  return { outcome: unrealised > 0 ? "unrealised" : "healthy", liquidatable, repaid, seized, realised: 0, unrealised };
}

/**
 * The fall in the collateral's price, against the loan asset, at which a position becomes
 * liquidatable (1 - 1/HF) and at which a full liquidation leaves bad debt (1 - debt * LIF / value).
 * Zero when it already is. Both assume the oracle follows the price.
 */
export function thresholds(debt: number, oracleValue: number, lltv: number, lif: number): { liquidation: number; badDebt: number } {
  if (debt <= 0) return { liquidation: 1, badDebt: 1 };
  if (oracleValue <= 0) return { liquidation: 0, badDebt: 0 };
  return {
    liquidation: Math.max(0, 1 - debt / (oracleValue * lltv)),
    badDebt: Math.max(0, 1 - (debt * lif) / oracleValue),
  };
}
