// The price of cover for one vault's depositors, in the same form as engine/src/pricing.ts:
//
//   rate = expected yearly loss / limit * (1 + risk load) + capital charge
//
// Each collateral token the vault lends against fails in a year with its class's probability
// (docs/RESEARCH.md section 1). When it fails it falls by one of the falls seen in the class's
// incidents, each equally likely, so the loss given failure is the mean of the losses at those falls.
// The loss each fall puts on the vault comes from the depeg scenario. Tokens fail one at a time, so the
// expected loss is the sum over tokens. The limit is the cover that keeps depositors whole through any
// one token's failure.
//
// A token in a class the research does not cover keeps a placeholder rate. A vault that lends against
// one carries `placeholder: true`, and the placeholder tokens are listed.

import { type LendingConfig, tokenRate } from "./config.js";
import { type VaultExposure, frac, usd } from "./report.js";
import { type PreparedBook, runScenario } from "./scenarios.js";

export interface TokenRisk {
  token: string;
  symbol: string;
  class: string;
  pt: boolean;
  annualProbability: number;
  /** The falls drawn from the class's incidents. */
  falls: number[];
  /** Loss to the vault's depositors if this token fails, the mean over the falls, in USD. */
  lossUsd: number;
  placeholder: boolean;
  /** annualProbability * lossUsd */
  expectedLossUsd: number;
}

export interface VaultPrice {
  vault: string;
  name: string | null;
  supplyUsd: number;
  /** Cover limit: the largest loss any one token's failure causes. */
  limitUsd: number;
  expectedLossUsd: number;
  expectedLossRate: number;
  /** Yearly premium as a share of the limit. */
  rate: number;
  annualPremiumUsd: number;
  /** The premium as a share of the vault's supply, what depositors would give up in yield. */
  premiumOnSupply: number;
  tokens: TokenRisk[];
  /** True when any token the vault lends against has a placeholder rate. */
  placeholder: boolean;
  placeholderTokens: string[];
}

/** Loss to one vault when `token` falls by `shock` and the oracle follows. */
function vaultLossAt(prep: PreparedBook, cfg: LendingConfig, vault: string, token: string, shock: number): number {
  let total = 0;
  for (const r of runScenario(prep, cfg, { kind: "depeg", token, shock })) {
    const pm = prep.markets.find((m) => m.market.id === r.marketId);
    if (!pm) continue;
    const share = pm.suppliers.filter((s) => s.vault === vault).reduce((a, s) => a + s.share, 0);
    total += (r.realised + r.unrealised) * pm.loanUsd * share;
  }
  return total;
}

export function priceVault(prep: PreparedBook, cfg: LendingConfig, v: VaultExposure): VaultPrice {
  const tokens = v.byToken.map((t) => {
    const rate = tokenRate(t.symbol, cfg);
    const falls = rate.incidents.map((i) => i.fall);
    const lossUsd = falls.reduce((a, f) => a + vaultLossAt(prep, cfg, v.vault, t.token, f), 0) / falls.length;
    return {
      token: t.token,
      symbol: t.symbol,
      class: rate.class,
      pt: rate.pt,
      annualProbability: frac(rate.annualProbability),
      falls,
      lossUsd: usd(lossUsd),
      expectedLossUsd: usd(rate.annualProbability * lossUsd),
      placeholder: rate.placeholder,
    };
  });
  const limitUsd = Math.max(0, ...tokens.map((t) => t.lossUsd));
  const expectedLossUsd = tokens.reduce((a, t) => a + t.expectedLossUsd, 0);
  const expectedLossRate = limitUsd > 0 ? expectedLossUsd / limitUsd : 0;
  const rate = expectedLossRate * (1 + cfg.pricing.riskLoad) + cfg.pricing.capitalCharge;
  const placeholderTokens = tokens.filter((t) => t.placeholder).map((t) => t.symbol);
  return {
    vault: v.vault,
    name: v.name,
    supplyUsd: v.supplyUsd,
    limitUsd,
    expectedLossUsd: usd(expectedLossUsd),
    expectedLossRate: frac(expectedLossRate),
    rate: frac(rate),
    annualPremiumUsd: usd(rate * limitUsd),
    premiumOnSupply: v.supplyUsd > 0 ? frac((rate * limitUsd) / v.supplyUsd) : 0,
    tokens,
    placeholder: placeholderTokens.length > 0,
    placeholderTokens,
  };
}
