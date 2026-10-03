// Every assumption the engine makes, in one place.
//
// Values marked "Perpl docs" come from docs.perpl.xyz or the Exchange contract and are read
// from the snapshot when it carries them. Values marked "assumption" are our judgement and
// are the levers to argue about. Change them here, never inline.

export interface EngineConfig {
  /** Simulation step in seconds. Liquidations are checked once per step. */
  stepSeconds: number;

  stress: {
    /**
     * Seconds over which the outside price falls to the chosen drop. Assumption: ten minutes. The
     * Monte Carlo feeds in each day's worst one-hour fall, so this plays an hour's fall six times
     * faster than it happened, on the cautious side.
     */
    shockSeconds: number;
    /** Seconds to hold the final price so pending liquidations can finish. Assumption. */
    holdSeconds: number;
  };

  mark: {
    /** Perpl docs (Price Indices): the published mark is clamped to within 25 bps of the Chainlink spot index. */
    bandToSpot: number;
    /**
     * Weight of Perpl's own book in the mark before the clamp. Perpl docs: the mark is the median of four
     * inputs, two of which (impact mid, book price) come from Perpl's own book. We model the median as a
     * blend with this weight. Assumption on the form; the 2 of 4 count is from the docs.
     */
    localBookWeight: number;
  };

  book: {
    /**
     * Share of posted depth still standing in a crash. Market makers pull and widen quotes when price
     * moves fast. Assumption: half the book stays.
     */
    stressDepthFactor: number;
    /**
     * Seconds for eaten depth to refill, as an e-folding time. After this long, about 63% of the depth
     * eaten by forced selling is back at each level. Assumption: market makers re-quote within a couple
     * of minutes.
     */
    refillSeconds: number;
    /**
     * Extra bid depth beyond the deepest posted level, in dollars per 1% of further distance from spot.
     * Assumption: zero. The book in the snapshot is all there is.
     */
    tailDepthUsdPerPct: number;
    /** Perpl docs (Price Indices): the impact price walks the book to $1,000, $2,000 and $5,000. We use $5,000. */
    impactNotionalUsd: number;
  };

  backstop: {
    /**
     * Discount at which the backstop buyer takes a position the book cannot absorb. Perpl docs: PLP
     * buy-to-liquidate, with btlPriceThreshPer100K = 95,000 on BTC, read as a 5% discount to mark.
     */
    discount: number;
    /**
     * Dollars of liquidated notional the backstop buyer can take in one event. Assumption: Perpl does not
     * publish PLP's capacity for this. Set to 0 to model the buyer being out of the market.
     */
    capacityUsd: number;
  };

  liquidation: {
    /** Steps between the mark crossing a liquidation price and the liquidation order hitting the book. Assumption: one block-ish. */
    delaySteps: number;
    /**
     * How far below the mark a liquidation order may fill on the book. Beyond this the order waits for
     * depth to refill, or the position is deleveraged once it is bankrupt. Assumption: 5%, the same
     * distance as the buy-to-liquidate threshold.
     */
    maxSlippage: number;
    /**
     * What happens to a position the mark carries past its bankruptcy price before it is sold.
     * "adl" (default): Perpl's design (docs, Insurance & ADL; co-founder's posts of 15 Oct and 20 Nov
     * 2025). It is deleveraged against profitable positions at its bankruptcy price. The winners'
     * shortfall against the mark is the bad debt: the insurance fund pays them the difference, then the
     * Spillway layer, and only what is left is lost by the winners.
     * "fund": the fund takes the position on and sells it at whatever the book pays, as most
     * centralised exchanges do. Costs more in a thin book.
     */
    bankruptPolicy: "fund" | "adl";
    /**
     * Perpl docs: liquidation sends 10% of the remaining margin to the insurance fund. When the snapshot
     * carries the market's split it wins over this default.
     */
    split: { trader: number; insurance: number; protocol: number };
  };

  layer: {
    /** Spillway layer limit in dollars. It attaches where the insurance fund runs out. */
    limitUsd: number;
  };

  gap: {
    /**
     * Seconds over which a gap's fall happens. A gap is a fall that takes place while liquidations are
     * paused, so nothing can be sold on the way down and the mark jumps when they resume. One second
     * stands for "all at once".
     */
    seconds: number;
  };

  pause: {
    /**
     * Perpl contract: liquidation and settlement are refused while the on-chain spot price is older than
     * refPriceMaxAgeSec, 60 seconds on BTC. A stall in the oracle or the chain longer than this pauses
     * liquidations. We take the move in the worst minute of a stressed day as the gap it leaves.
     */
    seconds: number;
    /**
     * Pauses a year that land on a stressed day. Assumption, and the biggest lever on the price of the
     * layer: Perpl does not publish its oracle or chain stall history. Shown next to every price.
     */
    perYear: number;
    /**
     * First day of history the pause gaps are drawn from. Assumption: before 2020, Coinbase's book was
     * thin enough for one-minute wicks of up to 17.5% on one venue that a multi-venue oracle such as
     * Chainlink would not have shown. Since 2020 the worst minute is 16.3% (13 March 2020) and every
     * other stressed day stayed under 6%.
     */
    since: string;
  };

  capacity: {
    /** Largest multiple of today's open interest searched. Perpl caps BTC at 300 BTC, about 31x 2 Oct 2026. */
    maxFactor: number;
  };

  monteCarlo: {
    years: number;
    seed: number;
    /** Daily price moves sampled per simulated year. */
    daysPerYear: number;
  };

  pricing: {
    /** Multiple of expected loss added for the risk that the model is wrong. Assumption. */
    riskLoad: number;
    /**
     * Yearly return capital wants for being locked in the vault even if nothing ever happens, as a
     * share of the limit. Assumption: about what a dollar earns parked elsewhere on chain.
     */
    capitalCharge: number;
  };

  /** Drop sizes for the stress curve, as fractions. */
  stressGrid: number[];
}

const grid = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let i = 0; from + i * step <= to + 1e-12; i++) out.push(Math.round((from + i * step) * 1e6) / 1e6);
  return out;
};

export const DEFAULT_CONFIG: EngineConfig = {
  stepSeconds: 1,
  stress: { shockSeconds: 600, holdSeconds: 300 },
  mark: { bandToSpot: 0.0025, localBookWeight: 0.5 },
  book: { stressDepthFactor: 0.5, refillSeconds: 120, tailDepthUsdPerPct: 0, impactNotionalUsd: 5_000 },
  backstop: { discount: 0.05, capacityUsd: 250_000 },
  liquidation: { delaySteps: 1, maxSlippage: 0.05, bankruptPolicy: "adl", split: { trader: 0.8, insurance: 0.1, protocol: 0.1 } },
  layer: { limitUsd: 250_000 },
  gap: { seconds: 1 },
  pause: { seconds: 60, perYear: 2, since: "2020-01-01" },
  capacity: { maxFactor: 40 },
  monteCarlo: { years: 20_000, seed: 20251010, daysPerYear: 365 },
  pricing: { riskLoad: 1.0, capitalCharge: 0.04 },
  stressGrid: grid(0.005, 0.4, 0.005),
};

export type ConfigOverrides = {
  [K in keyof EngineConfig]?: EngineConfig[K] extends number[] ? number[] : EngineConfig[K] extends object ? Partial<EngineConfig[K]> : EngineConfig[K];
};

export function withConfig(overrides: ConfigOverrides = {}, base: EngineConfig = DEFAULT_CONFIG): EngineConfig {
  const out = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = Array.isArray(v) || typeof v !== "object" || typeof cur !== "object" ? v : { ...(cur as object), ...v };
  }
  return out as unknown as EngineConfig;
}
