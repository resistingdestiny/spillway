// Every assumption the lending model makes, in one place.
//
// Values marked "Morpho Blue" are constants of the protocol (morpho-org/morpho-blue,
// src/libraries/ConstantsLib.sol). Values marked "assumption" are our judgement and are the levers to
// argue about. Values marked "PLACEHOLDER" have not been researched yet: they make the pricing run
// end to end and must not be read as estimates. Change them here, never inline.

export type CollateralClass =
  | "bridged-major"
  | "liquid-staking"
  | "yield-stablecoin"
  | "pendle-pt"
  | "managed-strategy"
  | "tokenised-gold"
  | "unclassified";

export interface FailureRate {
  /** Chance in a year that a token of this class fails. */
  annualProbability: number;
  /** How far the token falls against the loan asset when it fails, as a fraction. */
  severity: number;
  /** Where the numbers come from. */
  source: string;
}

export interface LendingConfig {
  morpho: {
    /** Morpho Blue: LIQUIDATION_CURSOR = 0.3e18. */
    liquidationCursor: number;
    /** Morpho Blue: MAX_LIQUIDATION_INCENTIVE_FACTOR = 1.15e18. */
    maxLiquidationIncentive: number;
  };

  /**
   * Depeg sizes for every stress curve: how far one collateral token falls against its loan asset, as
   * a fraction, 0 to 100% in 1% steps. 0 is the book as it stands.
   */
  shockGrid: number[];

  /** Shocks at which the tables (PML, vault exposure, cover limits) report. Assumption. */
  reportShocks: number[];

  thinExit: {
    /**
     * Dollars of each collateral token (by address) that liquidators can sell within the liquidation
     * incentive, that is with slippage below 1 - 1/LIF. A token not listed has unlimited depth:
     * liquidators always act, and the thin exit scenario equals the depeg. Assumption: none listed
     * until exit depth on Monad's exchanges is measured.
     */
    exitDepthUsd: Record<string, number>;
  };

  pml: {
    /**
     * The fall that counts as a token's failure when ranking collateral tokens. Assumption: 100%, the
     * token is worth nothing, the worst case of the collateral failures docs/LENDING.md lists. The
     * tables also report smaller falls.
     */
    rankShock: number;
  };

  pricing: {
    /**
     * PLACEHOLDER. Annual failure probability and severity by collateral class. Not researched: the
     * values only make the formula run. Research on how often each class has failed replaces them.
     */
    classes: Record<CollateralClass, FailureRate>;
    /** Class of each collateral token, by symbol. Assumption, from what each token is. */
    tokenClass: Record<string, CollateralClass>;
    /** Class for any symbol starting with "PT-": Pendle principal tokens. */
    ptPrefixClass: CollateralClass;
    /** Multiple of expected loss added for the risk that the model is wrong. Assumption, as in engine/src/config.ts. */
    riskLoad: number;
    /**
     * Yearly return capital wants for being locked in the cover even if nothing happens, as a share of
     * the limit. Assumption, as in engine/src/config.ts.
     */
    capitalCharge: number;
  };

  /** How many single positions the report lists as the largest risks. */
  topPositions: number;
}

const grid = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let i = 0; from + i * step <= to + 1e-12; i++) out.push(Math.round((from + i * step) * 1e6) / 1e6);
  return out;
};

const PLACEHOLDER = "PLACEHOLDER, not researched";

export const DEFAULT_CONFIG: LendingConfig = {
  morpho: { liquidationCursor: 0.3, maxLiquidationIncentive: 1.15 },
  shockGrid: grid(0, 1, 0.01),
  reportShocks: [0.05, 0.1, 0.25, 0.5, 1],
  thinExit: { exitDepthUsd: {} },
  pml: { rankShock: 1 },
  pricing: {
    classes: {
      "bridged-major": { annualProbability: 0.005, severity: 1, source: PLACEHOLDER },
      "liquid-staking": { annualProbability: 0.01, severity: 0.3, source: PLACEHOLDER },
      "yield-stablecoin": { annualProbability: 0.04, severity: 0.8, source: PLACEHOLDER },
      "pendle-pt": { annualProbability: 0.03, severity: 0.6, source: PLACEHOLDER },
      "managed-strategy": { annualProbability: 0.05, severity: 0.6, source: PLACEHOLDER },
      "tokenised-gold": { annualProbability: 0.005, severity: 0.5, source: PLACEHOLDER },
      unclassified: { annualProbability: 0.1, severity: 1, source: PLACEHOLDER },
    },
    tokenClass: {
      // Bridged to Monad: the bridge is the failure that matters, not the asset's own price.
      WETH: "bridged-major",
      WBTC: "bridged-major",
      cbBTC: "bridged-major",
      SOL: "bridged-major",
      WMON: "bridged-major",
      wstETH: "liquid-staking",
      weETH: "liquid-staking",
      LBTC: "liquid-staking",
      // Dollar tokens that earn a yield from a strategy, a basis trade or private credit.
      strUSD: "yield-stablecoin",
      syzUSD: "yield-stablecoin",
      savUSD: "yield-stablecoin",
      earnAUSD: "yield-stablecoin",
      gAUSD: "yield-stablecoin",
      vUSD: "yield-stablecoin",
      naccUSDC: "yield-stablecoin",
      YZM: "yield-stablecoin",
      FUSDLP: "yield-stablecoin",
      USPC: "yield-stablecoin",
      AA_FalconXUSDC: "yield-stablecoin",
      syrupUSDC: "yield-stablecoin",
      sUSDe: "yield-stablecoin",
      USDe: "yield-stablecoin",
      wsrUSD: "yield-stablecoin",
      reUSD: "yield-stablecoin",
      siUSD: "yield-stablecoin",
      // Tokens for a managed trading or yield strategy.
      aHYPER: "managed-strategy",
      mHYPER: "managed-strategy",
      aHyperBTC: "managed-strategy",
      mHyperBTC: "managed-strategy",
      mROX: "managed-strategy",
      triBTC: "managed-strategy",
      XAUt0: "tokenised-gold",
    },
    ptPrefixClass: "pendle-pt",
    riskLoad: 1.0,
    capitalCharge: 0.04,
  },
  topPositions: 10,
};

/** The pricing class of a collateral token. */
export function classOf(symbol: string, cfg: LendingConfig): CollateralClass {
  const known = cfg.pricing.tokenClass[symbol];
  if (known) return known;
  return symbol.startsWith("PT-") ? cfg.pricing.ptPrefixClass : "unclassified";
}
