// Every assumption the engine makes, in one place.
//
// Values marked "Perpl docs" come from docs.perpl.xyz or the Exchange contract and are read
// from the snapshot when it carries them. Values marked "assumption" are our judgement and
// are the levers to argue about. Change them here, never inline.

export interface EngineConfig {
  /** Simulation step in seconds. Liquidations are checked once per step. */
  stepSeconds: number;

  stress: {
    /** Seconds over which the outside price falls to the chosen drop. Assumption: a fast crash, as on 10 Oct 2025, plays out over minutes. */
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
     * "fund": the fund takes it on and sells it at whatever the book pays, and only an empty fund and
     * layer push the loss onto winners. This is the waterfall Spillway proposes, and how most
     * centralised exchanges run their insurance funds.
     * "adl": Perpl today (docs, Insurance & ADL): it is deleveraged against profitable positions at
     * the mark, and the fund is not touched.
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
  stress: { shockSeconds: 300, holdSeconds: 300 },
  mark: { bandToSpot: 0.0025, localBookWeight: 0.5 },
  book: { stressDepthFactor: 0.5, refillSeconds: 120, tailDepthUsdPerPct: 0, impactNotionalUsd: 5_000 },
  backstop: { discount: 0.05, capacityUsd: 250_000 },
  liquidation: { delaySteps: 1, maxSlippage: 0.05, bankruptPolicy: "fund", split: { trader: 0.8, insurance: 0.1, protocol: 0.1 } },
  layer: { limitUsd: 250_000 },
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
