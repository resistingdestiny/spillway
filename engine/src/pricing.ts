// The price of the layer: what the exchange pays depositors each year, as a share of the limit.
//
//   rate = expected yearly layer loss / limit * (1 + risk load) + capital charge
//
// The expected loss comes from the Monte Carlo. The risk load pays for the chance the model is
// wrong. The capital charge pays for locking the money up at all.

import type { EngineConfig } from "./config.js";
import type { MonteCarloResult } from "./montecarlo.js";

export interface LayerPrice {
  limit: number;
  /** Expected yearly payout from the layer. */
  expectedLoss: number;
  expectedLossRate: number;
  /** Chance in a year that the layer pays anything. */
  probabilityOfLoss: number;
  /** Yearly premium as a share of the limit. */
  rate: number;
  /** Yearly premium in dollars when the layer is fully funded. */
  annualPremium: number;
}

export function priceLayer(mc: MonteCarloResult, cfg: EngineConfig): LayerPrice {
  const limit = mc.layerLimit;
  const expectedLoss = mc.expected.layerPaid;
  const expectedLossRate = limit > 0 ? expectedLoss / limit : 0;
  const rate = expectedLossRate * (1 + cfg.pricing.riskLoad) + cfg.pricing.capitalCharge;
  return {
    limit,
    expectedLoss,
    expectedLossRate,
    probabilityOfLoss: mc.pLayer,
    rate,
    annualPremium: rate * limit,
  };
}
