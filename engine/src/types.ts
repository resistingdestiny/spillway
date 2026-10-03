// Shapes shared by the snapshot reader, the engine and the web app.
// The snapshot shape mirrors docs/ARCHITECTURE.md ("spillway.snapshot/1").

export type Side = "long" | "short";

export interface SnapshotPosition {
  accountId: number;
  side: Side;
  /** Asset units. */
  size: number;
  entryPrice: number;
  /** Collateral posted to this position, in dollars. */
  deposit: number;
  /** Funding PnL, signed. Positive means the position has received funding. */
  premiumPnl: number;
  deltaPnl?: number;
  /** As computed by the Perpl SDK, for cross-checking. */
  liquidationPrice?: number;
  bankruptcyPrice?: number;
}

/** [price, size, orders] */
export type BookLevel = [number, number, number];

export interface SnapshotMarket {
  perpId: number;
  symbol: string;
  name?: string;
  priceDecimals: number;
  lotDecimals: number;
  markPrice: number;
  oraclePrice: number;
  lastPrice: number;
  maintenanceMarginFraction: number;
  initialMarginFraction: number;
  takerFee?: number;
  makerFee?: number;
  longOpenInterest: number;
  shortOpenInterest: number;
  insuranceFund: number;
  positionBalance?: number;
  liquidationSplit: { trader: number; insurance: number; protocol: number };
  feeInsuranceShare?: number;
  fundingRate?: number;
}

export interface Snapshot {
  schema: "spillway.snapshot/1";
  network: "mainnet" | "testnet" | "synthetic";
  chainId: number;
  exchange?: string;
  block: number;
  blockTimestamp: number;
  takenAt: string;
  source?: Record<string, string>;
  market: SnapshotMarket;
  positions: SnapshotPosition[];
  book: { bids: BookLevel[]; asks: BookLevel[] };
}

/** A price path for the outside market, as a multiple of the starting price over time. */
export interface PricePath {
  /** Seconds from the start of the run. Strictly increasing, starts at 0. */
  t: number[];
  /** Spot as a multiple of the starting spot price. Starts at 1. */
  ratio: number[];
}

export type LiquidationPath =
  /** Sold into Perpl's order book. */
  | "book"
  /** Bought by the backstop buyer (Perpl's PLP buy-to-liquidate) at a discount. */
  | "backstop"
  /** Mark passed the bankruptcy price before the position could be sold; deleveraged at the mark. */
  | "gap"
  /** Mark passed the bankruptcy price; the fund took the position on and sold it into the book. */
  | "system";

export interface LiquidationFill {
  t: number;
  accountId: number;
  side: Side;
  /** Asset units closed in this fill. */
  size: number;
  /** Average fill price for this piece. */
  price: number;
  path: LiquidationPath;
  liquidationPrice: number;
  bankruptcyPrice: number;
  /** Margin left after the fill, if positive. Split between trader, fund and protocol. */
  residual: number;
  /** Loss beyond the trader's margin. This is the water. */
  badDebt: number;
  /** Price on Perpl's book right after this fill. */
  bookPriceAfter: number;
}

export type TimelineEvent =
  | { t: number; kind: "trigger"; accountId: number; side: Side; size: number; mark: number; liquidationPrice: number }
  | ({ kind: "fill" } & LiquidationFill)
  | { t: number; kind: "fund_income"; amount: number; accountId: number }
  | { t: number; kind: "fund_draw"; amount: number; accountId: number }
  | { t: number; kind: "layer_draw"; amount: number; accountId: number }
  | { t: number; kind: "adl"; amount: number; accountId: number }
  | { t: number; kind: "settle" };

/** State sampled once per step. The renderer interpolates between frames; counters read the frame at or before t. */
export interface Frame {
  t: number;
  /** Outside price (Chainlink spot). The ghost marker. */
  spot: number;
  /** Perpl mark price, clamped near spot. Triggers liquidations. */
  mark: number;
  /** Where Perpl's own book trades after forced selling. The real marker. */
  bookPrice: number;
  /** Insurance fund balance. */
  fund: number;
  /** Layer limit still available. */
  layerRemaining: number;
  badDebt: number;
  fundPaid: number;
  layerPaid: number;
  tradersLose: number;
  liquidatedNotional: number;
  liquidations: number;
}

export interface RunTotals {
  badDebt: number;
  fundPaid: number;
  layerPaid: number;
  tradersLose: number;
  fundIncome: number;
  liquidatedNotional: number;
  liquidations: number;
  /** Positions whose margin was fully lost. */
  bankruptcies: number;
  fundStart: number;
  fundEnd: number;
  layerLimit: number;
  spotStart: number;
  spotEnd: number;
  /** Lowest price Perpl's book traded at during the run. */
  bookLow: number;
  /** Seconds of simulated time. */
  duration: number;
  /** Which band the water reached: 0 dry, 1 fund, 2 layer, 3 traders. */
  band: 0 | 1 | 2 | 3;
}

export interface RunResult {
  kind: "stress" | "gap" | "replay";
  label: string;
  direction: "down" | "up";
  frames: Frame[];
  events: TimelineEvent[];
  totals: RunTotals;
}
