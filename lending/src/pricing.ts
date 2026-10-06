// The price of cover for one vault's depositors, in the same form as engine/src/pricing.ts:
//
//   rate = expected yearly loss / limit * (1 + risk load) + capital charge
//
// Each collateral token the vault lends against fails in a year with its class's probability, and
// falls by its class's severity when it does. The loss that fall puts on the vault comes from the
// depeg scenario. Tokens fail one at a time, so the expected loss is the sum over tokens. The limit is
// the cover that keeps depositors whole through any one token's failure.
//
// The failure table in config.ts is a PLACEHOLDER. Every result carries `placeholder: true` until it
// is replaced by research.

import { type LendingConfig, classOf } from "./config.js";
import { usd, frac } from "./report.js";
import { type PreparedBook, runScenario } from "./scenarios.js";
import type { VaultExposure } from "./report.js";

export interface TokenRisk {
  token: string;
  symbol: string;
  class: string;
  annualProbability: number;
  severity: number;
  /** Loss to the vault's depositors if this token fails, in USD. */
  lossUsd: number;
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
  placeholder: boolean;
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
    const cls = classOf(t.symbol, cfg);
    const rate = cfg.pricing.classes[cls];
    const lossUsd = vaultLossAt(prep, cfg, v.vault, t.token, rate.severity);
    return {
      token: t.token,
      symbol: t.symbol,
      class: cls,
      annualProbability: rate.annualProbability,
      severity: rate.severity,
      lossUsd: usd(lossUsd),
      expectedLossUsd: usd(rate.annualProbability * lossUsd),
    };
  });
  const limitUsd = Math.max(0, ...tokens.map((t) => t.lossUsd));
  const expectedLossUsd = tokens.reduce((a, t) => a + t.expectedLossUsd, 0);
  const expectedLossRate = limitUsd > 0 ? expectedLossUsd / limitUsd : 0;
  const rate = expectedLossRate * (1 + cfg.pricing.riskLoad) + cfg.pricing.capitalCharge;
  const placeholder = tokens.some((t) => cfg.pricing.classes[t.class as keyof typeof cfg.pricing.classes].source.startsWith("PLACEHOLDER"));
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
    placeholder,
  };
}
