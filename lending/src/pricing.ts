// The price of cover for one vault's depositors, in the same form as engine/src/pricing.ts:
//
//   rate = expected yearly loss to the cover / limit * (1 + risk load) + capital charge
//
// Each collateral token the vault lends against fails in a year with its class's probability
// (docs/RESEARCH.md section 1; a PT adds the PT-specific term). When it fails it falls by one of the
// falls seen in the class's incidents, each equally likely. The loss each fall puts on the vault comes
// from the thin exit scenario, the headline default: liquidators act only as far as Monad's exit depth
// lets them. Tokens fail one at a time, so the expected loss is the sum over tokens:
//
//   expected yearly loss to depositors = sum over tokens of p(class) x mean over falls of loss(fall)
//
// The limit is the cover that keeps depositors whole when any one token falls by its class's 90th
// percentile fall (config.pricing.limitQuantile). A fall beyond that can cost more than the limit, and
// the cover pays at most the limit, so the cover's expected loss caps each loss at the limit. The rate
// is priced on that capped figure. Both are reported.
//
// A token in a class the research does not cover keeps a placeholder rate. A vault that lends against
// one carries `placeholder: true`, and the placeholder tokens are listed.

import { type LendingConfig, severityQuantile, tokenRate } from "./config.js";
import { type VaultExposure, frac, usd } from "./report.js";
import { type PreparedBook, type ScenarioKind, runScenario } from "./scenarios.js";

export interface TokenRisk {
  token: string;
  symbol: string;
  class: string;
  pt: boolean;
  annualProbability: number;
  /** 90% range on annualProbability. */
  range: [number, number];
  /** The falls drawn from the class's incidents, and the loss to the vault's depositors at each, in USD. */
  falls: { fall: number; lossUsd: number }[];
  /** Mean loss over the falls: the loss to depositors if this token fails, in USD. */
  lossUsd: number;
  /** The same with liquidators always acting. */
  lossAlwaysActUsd: number;
  /** The class's 90th percentile fall, and the loss to depositors at it. */
  limitFall: number;
  limitLossUsd: number;
  /** annualProbability x lossUsd */
  expectedLossUsd: number;
  placeholder: boolean;
}

export interface VaultPrice {
  vault: string;
  name: string | null;
  supplyUsd: number;
  /** Cover limit: the largest loss any one token's 90th percentile fall causes. */
  limitUsd: number;
  limitToken: string | null;
  /** Expected yearly loss to the vault's depositors, uncapped, and at both ends of the 90% ranges. */
  expectedLossUsd: number;
  expectedLossRangeUsd: [number, number];
  /** The same with liquidators always acting, for comparison. */
  expectedLossAlwaysActUsd: number;
  /** Expected yearly loss the cover pays: each loss capped at the limit. */
  coverExpectedLossUsd: number;
  /** coverExpectedLossUsd / limitUsd */
  expectedLossRate: number;
  /** Yearly premium as a share of the limit, and with every class at the top of its 90% range. */
  rate: number;
  rateHigh: number;
  annualPremiumUsd: number;
  /** The premium as a share of the vault's supply, what depositors would give up in yield. */
  premiumOnSupply: number;
  tokens: TokenRisk[];
  /** True when any token the vault lends against has a placeholder rate. */
  placeholder: boolean;
  placeholderTokens: string[];
}

/** Loss to one vault when `token` falls by `shock`, in USD. */
function vaultLossAt(prep: PreparedBook, cfg: LendingConfig, vault: string, token: string, shock: number, kind: ScenarioKind = "thin"): number {
  let total = 0;
  for (const r of runScenario(prep, cfg, { kind, token, shock })) {
    const pm = prep.markets.find((m) => m.market.id === r.marketId);
    if (!pm) continue;
    const share = pm.suppliers.filter((s) => s.vault === vault).reduce((a, s) => a + s.share, 0);
    total += (r.realised + r.unrealised) * pm.loanUsd * share;
  }
  return total;
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, x) => a + x, 0) / xs.length);

export function priceVault(prep: PreparedBook, cfg: LendingConfig, v: VaultExposure): VaultPrice {
  const raw = v.byToken.map((t) => {
    const rate = tokenRate(t.symbol, cfg);
    const falls = rate.incidents.map((i) => ({ fall: i.fall, loss: vaultLossAt(prep, cfg, v.vault, t.token, i.fall) }));
    const limitFall = severityQuantile(rate, cfg.pricing.limitQuantile);
    return {
      t,
      rate,
      falls,
      loss: mean(falls.map((f) => f.loss)),
      lossAlwaysAct: mean(rate.incidents.map((i) => vaultLossAt(prep, cfg, v.vault, t.token, i.fall, "depeg"))),
      limitFall,
      limitLoss: vaultLossAt(prep, cfg, v.vault, t.token, limitFall),
    };
  });
  const worst = raw.reduce<(typeof raw)[number] | null>((a, r) => (r.limitLoss > (a?.limitLoss ?? 0) ? r : a), null);
  const limit = worst?.limitLoss ?? 0;
  const sum = (f: (r: (typeof raw)[number]) => number) => raw.reduce((a, r) => a + f(r), 0);
  const expectedLoss = sum((r) => r.rate.annualProbability * r.loss);
  const coverLoss = (p: (r: (typeof raw)[number]) => number) => sum((r) => p(r) * mean(r.falls.map((f) => Math.min(f.loss, limit))));
  const coverExpected = coverLoss((r) => r.rate.annualProbability);
  const coverHigh = coverLoss((r) => r.rate.range[1]);
  const priced = (el: number) => (limit > 0 ? (el / limit) * (1 + cfg.pricing.riskLoad) + cfg.pricing.capitalCharge : 0);
  const rate = priced(coverExpected);
  const tokens: TokenRisk[] = raw.map((r) => ({
    token: r.t.token,
    symbol: r.t.symbol,
    class: r.rate.class,
    pt: r.rate.pt,
    annualProbability: frac(r.rate.annualProbability),
    range: [frac(r.rate.range[0]), frac(r.rate.range[1])],
    falls: r.falls.map((f) => ({ fall: f.fall, lossUsd: usd(f.loss) })),
    lossUsd: usd(r.loss),
    lossAlwaysActUsd: usd(r.lossAlwaysAct),
    limitFall: frac(r.limitFall),
    limitLossUsd: usd(r.limitLoss),
    expectedLossUsd: usd(r.rate.annualProbability * r.loss),
    placeholder: r.rate.placeholder,
  }));
  const placeholderTokens = tokens.filter((t) => t.placeholder).map((t) => t.symbol);
  return {
    vault: v.vault,
    name: v.name,
    supplyUsd: v.supplyUsd,
    limitUsd: usd(limit),
    limitToken: limit > 0 ? (worst?.t.symbol ?? null) : null,
    expectedLossUsd: usd(expectedLoss),
    expectedLossRangeUsd: [usd(sum((r) => r.rate.range[0] * r.loss)), usd(sum((r) => r.rate.range[1] * r.loss))],
    expectedLossAlwaysActUsd: usd(sum((r) => r.rate.annualProbability * r.lossAlwaysAct)),
    coverExpectedLossUsd: usd(coverExpected),
    expectedLossRate: frac(limit > 0 ? coverExpected / limit : 0),
    rate: frac(rate),
    rateHigh: frac(priced(coverHigh)),
    annualPremiumUsd: usd(rate * limit),
    premiumOnSupply: v.supplyUsd > 0 ? frac((rate * limit) / v.supplyUsd) : 0,
    tokens,
    placeholder: placeholderTokens.length > 0,
    placeholderTokens,
  };
}
