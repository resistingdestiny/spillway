// Every assumption the lending model makes, in one place.
//
// Values marked "Morpho Blue" are constants of the protocol (morpho-org/morpho-blue,
// src/libraries/ConstantsLib.sol). Values marked "assumption" are our judgement and are the levers to
// argue about. Values marked "research" come from docs/RESEARCH.md, whose raw data and scripts are in
// research/ (research/research-config.json holds every figure used here). Values marked "PLACEHOLDER"
// have not been researched: they make the pricing run end to end and must not be read as estimates.
// Change them here, never inline.

export type CollateralClass =
  | "synthetic-dollar"
  | "managed-strategy"
  | "lst-lrt"
  | "rwa-credit"
  | "wrapped-btc"
  | "major"
  | "tokenised-gold"
  | "unclassified";

/** One failure of a token in the class: how far it fell against its pre-incident price. */
export interface Incident {
  token: string;
  date: string;
  /** Lowest daily price against the pre-incident level, as a fall from 0 to 1. */
  fall: number;
  source: string;
}

export interface FailureRate {
  /** Chance in a year that a token of this class fails. */
  annualProbability: number;
  /** 90% range on annualProbability. */
  range: [number, number];
  /**
   * The falls seen when tokens of this class failed. A failure draws one of them, each equally likely,
   * so the expected loss given failure is the mean of the losses at these falls.
   */
  incidents: Incident[];
  /** Where the numbers come from. */
  source: string;
  /** True when the class has not been researched and its numbers only make the formula run. */
  placeholder: boolean;
}

/** Why a collateral token is in its class. */
export interface TokenClass {
  class: CollateralClass;
  /** A Pendle principal token: its underlying's class plus the PT-specific term. */
  pt?: true;
  reason: string;
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
     * Research, docs/RESEARCH.md section 3: the best quote found on Monad for selling each collateral
     * token (by symbol) into its loan asset, as [sale size in USD, output / (input x reference) - 1].
     * null is no route at that size, read as receiving nothing. The reference is the market's oracle
     * price for the eight largest markets and the API's USD price ratio for the rest, so a quote
     * includes any premium of oracle over market. Quotes taken 6 Oct 2026, 14:43 to 14:47 UTC.
     */
    quotes: Record<string, [number, number | null][]>;
    /**
     * Dollars of each collateral token (by address) that liquidators can sell within the liquidation
     * incentive, in every market that takes it. Wins over the quotes. Empty by default: it is the
     * lever for what-if runs and tests.
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
    /** Annual failure probability, its 90% range and the falls seen, by collateral class. */
    classes: Record<CollateralClass, FailureRate>;
    /**
     * Research: a PT adds this to its underlying's probability. No PT has failed apart from its
     * underlying, so this is a rule-of-three upper bound over an assumed 225.5 PT-years.
     */
    ptTerm: { annualProbability: number; source: string };
    /** Class of each collateral token, by symbol, with the reason. A symbol not listed is unclassified. */
    tokenClass: Record<string, TokenClass>;
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
const placeholder = (annualProbability: number, fall: number): FailureRate => ({
  annualProbability,
  range: [annualProbability, annualProbability],
  incidents: [{ token: PLACEHOLDER, date: "", fall, source: PLACEHOLDER }],
  source: PLACEHOLDER,
  placeholder: true,
});

// Incidents behind the severities, from docs/RESEARCH.md section 1, "Incidents used". Each fall is the
// lowest DefiLlama daily price against the pre-incident level (research-config.json, incidents).
const UST: Incident = { token: "UST", date: "2022-05-09", fall: 0.9935, source: "https://coins.llama.fi/chart/coingecko:terrausd?start=1651363200&span=200&period=1d" };
const SUSD: Incident = { token: "sUSD", date: "2025-04-10", fall: 0.246, source: "https://coins.llama.fi/chart/coingecko:nusd?start=1735689600&span=300&period=1d" };
const USDX: Incident = { token: "USDX (Stables Labs)", date: "2025-11-06", fall: 0.9901, source: "https://coins.llama.fi/chart/coingecko:usdx-money-usdx?start=1760918400&span=200&period=1d" };
// Headline figure: Stream disclosed a $93M fund loss and xUSD traded about 77% down.
const XUSD: Incident = { token: "xUSD (Stream)", date: "2025-11-04", fall: 0.77, source: "https://news.google.com/rss/search?q=Stream+Finance+xUSD+93+million" };
// sdeUSD now prices at $0.00000001, so the fall is taken as total.
const DEUSD: Incident = { token: "deUSD / sdeUSD (Elixir)", date: "2025-11-06", fall: 1, source: "https://coins.llama.fi/prices/current/ethereum:0x5C5b196aBE0d54485975D1Ec29617D42D9198326" };
const USR: Incident = { token: "USR (Resolv)", date: "2026-03-22", fall: 0.9149, source: "https://coins.llama.fi/chart/coingecko:resolv-usr?start=1773532800&span=200&period=1d" };

export const DEFAULT_CONFIG: LendingConfig = {
  morpho: { liquidationCursor: 0.3, maxLiquidationIncentive: 1.15 },
  shockGrid: grid(0, 1, 0.01),
  reportShocks: [0.05, 0.1, 0.25, 0.5, 1],
  thinExit: {
    quotes: {
      wstETH: [[1_000, -0.0072], [100_000, -0.1861], [1_000_000, -0.6885], [10_000_000, -0.9566]],
      aHYPER: [[1_000, -0.6984], [100_000, -0.9494], [1_000_000, -0.9996], [10_000_000, -1.0]],
      "PT-USDat-14JAN2027": [[1_000, -0.0006], [100_000, -0.0011], [1_000_000, -0.0083], [10_000_000, null]],
      earnAUSD: [[1_000, -0.0138], [100_000, -0.91], [1_000_000, -0.9877], [10_000_000, -0.9987]],
      strUSD: [[1_000, null], [100_000, null], [1_000_000, null], [10_000_000, null]],
      mROX: [[1_000, null], [100_000, null], [1_000_000, null], [10_000_000, null]],
      mHyperBTC: [[1_000, null], [100_000, null], [1_000_000, null], [10_000_000, null]],
      "PT-AUSD-8OCT2026": [[1_000, -0.0001], [100_000, -0.0001], [1_000_000, -0.0008], [10_000_000, -0.6667]],
      syrupUSDC: [[1_000, -0.001], [100_000, -0.0011], [1_000_000, -0.0023], [10_000_000, -0.5169]],
      USDe: [[1_000, -0.7774], [100_000, -0.9438], [1_000_000, -0.9897], [10_000_000, -0.9989]],
      vUSD: [[1_000, null], [100_000, null], [1_000_000, null], [10_000_000, null]],
      wsrUSD: [[1_000, -0.9442], [100_000, -0.9976], [1_000_000, -0.9998], [10_000_000, -1.0]],
      savUSD: [[1_000, -0.7831], [100_000, -0.9506], [1_000_000, -0.9953], [10_000_000, -0.9997]],
    },
    exitDepthUsd: {},
  },
  pml: { rankShock: 1 },
  pricing: {
    classes: {
      // Research, docs/RESEARCH.md section 1: Basis Trading, CDP and dual-token dollars, 6 failures in
      // 58.2 token-years. Severity from all six.
      "synthetic-dollar": {
        annualProbability: 0.1031,
        range: [0.0449, 0.2035],
        incidents: [UST, SUSD, USDX, XUSD, DEUSD, USR],
        source: "docs/RESEARCH.md section 1, synthetic / yield dollars",
        placeholder: false,
      },
      // Research, docs/RESEARCH.md section 1: the narrow figure, Basis Trading only and no sUSD, 5
      // failures in 25.2 token-years. It fits delta-neutral and managed tokens, whose failure is the
      // manager's loss. Severity from the five failures other than sUSD.
      "managed-strategy": {
        annualProbability: 0.1987,
        range: [0.0783, 0.4178],
        incidents: [UST, USDX, XUSD, DEUSD, USR],
        source: "docs/RESEARCH.md section 1, synthetic dollars, narrow",
        placeholder: false,
      },
      // Research, docs/RESEARCH.md section 1: 2 failures in 129.4 token-years. Only rsETH has a measured
      // fall (aBNBc's was not fetched), and it recovered because others paid.
      "lst-lrt": {
        annualProbability: 0.0155,
        range: [0.0027, 0.0487],
        incidents: [{ token: "rsETH (Kelp)", date: "2026-04-18", fall: 0.2007, source: "https://coins.llama.fi/chart/coingecko:kelp-dao-restaked-eth,coingecko:ethereum?start=1775347200&span=150&period=1d" }],
        source: "docs/RESEARCH.md section 1, LST and LRT",
        placeholder: false,
      },
      // Research, docs/RESEARCH.md section 1: 3 failures in 57.8 token-years. Only USDR has a measured
      // fall (Maple and Goldfinch are not confirmed).
      "rwa-credit": {
        annualProbability: 0.0519,
        range: [0.0141, 0.1341],
        incidents: [{ token: "USDR (Tangible)", date: "2023-10-11", fall: 0.4817, source: "https://coins.llama.fi/chart/coingecko:real-usd?start=1696118400&span=200&period=1d" }],
        source: "docs/RESEARCH.md section 1, RWA and credit",
        placeholder: false,
      },
      // Research, docs/RESEARCH.md section 1: 2 failures in 39.4 token-years. Only uniBTC has a measured
      // fall (multiBTC's was not fetched).
      "wrapped-btc": {
        annualProbability: 0.0508,
        range: [0.009, 0.16],
        incidents: [{ token: "uniBTC (Bedrock)", date: "2024-09-26", fall: 0.3324, source: "https://coins.llama.fi/chart/coingecko:universal-btc,coingecko:wrapped-bitcoin?start=1726790400&span=30&period=1d" }],
        source: "docs/RESEARCH.md section 1, wrapped BTC",
        placeholder: false,
      },
      // PLACEHOLDER: the research does not cover bridged majors, Monad's own coin or tokenised gold.
      major: placeholder(0.005, 1),
      "tokenised-gold": placeholder(0.005, 0.5),
      unclassified: placeholder(0.1, 1),
    },
    ptTerm: { annualProbability: 0.0133, source: "docs/RESEARCH.md section 1, Pendle PT, PT-specific term (rule of three)" },
    // Reasons cite docs/RESEARCH.md where it covers the token. "Assumption" marks a reading of what the
    // token is that the research does not confirm. A dollar token whose backing is not confirmed takes
    // the broad synthetic dollar class, the class most failed dollar tokens came from.
    tokenClass: {
      WETH: { class: "major", reason: "Bridged ETH. The research has no failure rate for bridged majors." },
      SOL: { class: "major", reason: "Bridged SOL. Not researched." },
      WMON: { class: "major", reason: "Monad's own coin, wrapped. Not researched." },
      XAUt0: { class: "tokenised-gold", reason: "Tokenised gold. Not researched." },
      WBTC: { class: "wrapped-btc", reason: "A BTC wrapper. WBTC is in the class's universe." },
      cbBTC: { class: "wrapped-btc", reason: "Coinbase's BTC wrapper." },
      LBTC: { class: "wrapped-btc", reason: "Lombard staked BTC. Lombard LBTC is in the class's universe." },
      triBTC: { class: "wrapped-btc", reason: "BTC-denominated token of unconfirmed backing, taken as a BTC wrapper. Assumption." },
      wstETH: { class: "lst-lrt", reason: "Lido wrapped staked ETH. Lido is in the class's universe." },
      weETH: { class: "lst-lrt", reason: "ether.fi restaked ETH. ether.fi is in the class's universe." },
      USDe: { class: "managed-strategy", reason: "Ethena's basis-trade dollar, which the narrow figure fits (RESEARCH.md section 1)." },
      sUSDe: { class: "managed-strategy", reason: "Staked USDe, Ethena's basis trade." },
      savUSD: { class: "managed-strategy", reason: "Avant's staked dollar, a delta-neutral strategy. Assumption." },
      aHYPER: { class: "managed-strategy", reason: "Share of the Hyperithm Delta Neutral Vault, priced at its reported share price (RESEARCH.md section 2)." },
      mHYPER: { class: "managed-strategy", reason: "Midas certificate on Hyperithm's strategy, as aHYPER. Assumption." },
      aHyperBTC: { class: "managed-strategy", reason: "Hyperithm's managed BTC strategy: the manager's loss is the failure. Assumption." },
      mHyperBTC: { class: "managed-strategy", reason: "Midas certificate on Hyperithm's BTC strategy, NAV pushed by the issuer (RESEARCH.md section 2)." },
      mROX: { class: "managed-strategy", reason: "Midas certificate on a managed strategy, NAV pushed by the issuer (RESEARCH.md section 2)." },
      earnAUSD: { class: "managed-strategy", reason: "Operator-reported NAV, 98.7% of assets outside the vault (RESEARCH.md section 2)." },
      strUSD: { class: "synthetic-dollar", reason: "Yield dollar priced by its issuer's exchange rate (RESEARCH.md section 2). Backing not confirmed." },
      wsrUSD: { class: "synthetic-dollar", reason: "Wrapped savings rUSD. Reservoir is in the class's universe." },
      syzUSD: { class: "synthetic-dollar", reason: "Staked yield dollar. Backing not confirmed." },
      siUSD: { class: "synthetic-dollar", reason: "Staked yield dollar. Backing not confirmed." },
      vUSD: { class: "synthetic-dollar", reason: "Yield dollar with no DEX route on Monad (RESEARCH.md section 3). Backing not confirmed." },
      YZM: { class: "synthetic-dollar", reason: "Dollar yield token priced above $1. Backing not confirmed." },
      FUSDLP: { class: "synthetic-dollar", reason: "Dollar LP token priced above $1. Backing not confirmed." },
      USPC: { class: "synthetic-dollar", reason: "Dollar token with no API price. Backing not confirmed." },
      gAUSD: { class: "synthetic-dollar", reason: "Dollar yield token on AUSD. Backing not confirmed." },
      naccUSDC: { class: "synthetic-dollar", reason: "Dollar yield token on USDC. Backing not confirmed." },
      syrupUSDC: { class: "rwa-credit", reason: "Maple's lending pool. Maple is in the class's universe." },
      reUSD: { class: "rwa-credit", reason: "Re's reinsurance-backed dollar. Re is in the class's universe." },
      AA_FalconXUSDC: { class: "rwa-credit", reason: "Senior tranche of a USDC credit line to FalconX, private credit. Assumption from the name." },
      "PT-USDat-14JAN2027": { class: "synthetic-dollar", pt: true, reason: "PT on USDat, a dollar of unconfirmed backing." },
      "PT-USDat-27AUG2026": { class: "synthetic-dollar", pt: true, reason: "PT on USDat, a dollar of unconfirmed backing." },
      "PT-sUSDat-14JAN2027": { class: "synthetic-dollar", pt: true, reason: "PT on staked USDat, a dollar of unconfirmed backing." },
      "PT-srUSDat-14JAN2027": { class: "synthetic-dollar", pt: true, reason: "PT on a USDat yield token, a dollar of unconfirmed backing." },
      "PT-AUSD-8OCT2026": { class: "rwa-credit", pt: true, reason: "PT on AUSD, a dollar backed by cash and T-bills. T-bill dollars (USDtb, USD0) are in the class's universe." },
      "PT-earnAUSD-8OCT2026": { class: "managed-strategy", pt: true, reason: "PT on earnAUSD, an operator-reported NAV (RESEARCH.md section 2)." },
      "PT-reUSD-10DEC2026": { class: "rwa-credit", pt: true, reason: "PT on reUSD. Re is in the RWA and credit universe." },
      TETH: { class: "unclassified", reason: "Test token with no USD price, lent against a test loan token." },
      stTEST: { class: "unclassified", reason: "Test token with no USD price." },
      testwstETH: { class: "unclassified", reason: "Test token with no USD price, lent against a test loan token." },
      COLLAT: { class: "unclassified", reason: "Test token with no USD price." },
      UNKNOWN: { class: "unclassified", reason: "No symbol in the API and no USD price. No borrowers." },
    },
    riskLoad: 1.0,
    capitalCharge: 0.04,
  },
  topPositions: 10,
};

/** The pricing class of a collateral token. */
export function classOf(symbol: string, cfg: LendingConfig): CollateralClass {
  return cfg.pricing.tokenClass[symbol]?.class ?? "unclassified";
}

export interface TokenRate extends FailureRate {
  class: CollateralClass;
  pt: boolean;
  reason: string;
}

/** A token's failure rate: its class's, plus the PT-specific term for a Pendle PT. */
export function tokenRate(symbol: string, cfg: LendingConfig): TokenRate {
  const tc = cfg.pricing.tokenClass[symbol] ?? { class: "unclassified" as const, reason: "Not in the token table." };
  const rate = cfg.pricing.classes[tc.class];
  const add = tc.pt ? cfg.pricing.ptTerm.annualProbability : 0;
  return {
    ...rate,
    annualProbability: rate.annualProbability + add,
    range: [rate.range[0], rate.range[1] + add],
    class: tc.class,
    pt: tc.pt === true,
    reason: tc.reason,
  };
}

/** The q-quantile of a class's falls, linear between the sorted incidents. */
export function severityQuantile(rate: FailureRate, q: number): number {
  const xs = rate.incidents.map((i) => i.fall).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const h = (xs.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(xs.length - 1, lo + 1);
  return (xs[lo] as number) + (h - lo) * ((xs[hi] as number) - (xs[lo] as number));
}
