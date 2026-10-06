// Scenarios: one collateral token fails, against its loan asset, in every market that takes it.
//
// Every large loss in 2025 and 2026 came from collateral failing, so the shock is to one token at a
// time rather than to the whole market (docs/LENDING.md):
//
// - depeg:  the token's price falls by `shock` and the oracle follows. Liquidators always act.
// - hidden: the token's price falls but the oracle does not (a fixed or exchange-rate oracle). Nothing
//           becomes liquidatable, so the loss stays unrealised until the oracle or a liquidator moves.
// - thin:   as a depeg, but liquidators only act up to the token's exit depth (config.thinExit). The
//           positions that turn liquidatable first, at the smallest fall, use the depth first.
//
// The fall is a jump: the oracle goes from today's price to the shocked price in one update, as when a
// failed token is repriced, and liquidators act at the new price. A slow slide with liquidators at work
// leaves no bad debt in Morpho Blue, because at the liquidation point LLTV * LIF < 1 always holds and
// the collateral still covers the debt plus the incentive.

import { type SupplierShare, supplierShares } from "./attribution.js";
import type { LendingConfig } from "./config.js";
import { collateralValue, debt, healthFactor } from "./fidelity.js";
import { type Outcome, type PositionResult, liquidationIncentive, positionOutcome } from "./model.js";
import { type LendingBook, type Market, positionsByMarket } from "./snapshot.js";

export type ScenarioKind = "depeg" | "hidden" | "thin";

export interface Scenario {
  kind: ScenarioKind;
  /** Collateral token address. */
  token: string;
  /** Fall in the token's price against the loan asset, 0 to 1. */
  shock: number;
}

export interface Borrower {
  user: string;
  /** Debt in loan tokens. */
  debt: number;
  /** Collateral value at the snapshot's oracle price, in loan tokens. */
  value: number;
  healthFactor: number;
}

/** A market made ready to shock: its borrowers in loan tokens and its suppliers' shares. */
export interface PreparedMarket {
  market: Market;
  lif: number;
  /** USD per loan token, 0 when the API does not price it. */
  loanUsd: number;
  borrowers: Borrower[];
  suppliers: SupplierShare[];
}

export interface PreparedBook {
  book: LendingBook;
  markets: PreparedMarket[];
  /** Markets that take each collateral token, by token address. */
  byToken: Map<string, PreparedMarket[]>;
}

export function prepare(book: LendingBook, cfg: LendingConfig): PreparedBook {
  const groups = positionsByMarket(book);
  const markets: PreparedMarket[] = [];
  for (const m of book.markets) {
    if (!m.collateral || m.price === null) continue;
    const ps = groups.get(m.id) ?? [];
    markets.push({
      market: m,
      lif: liquidationIncentive(m.lltv, cfg),
      loanUsd: m.loan.priceUsd ?? 0,
      borrowers: ps
        .filter((p) => p.borrowAssets > 0n)
        .map((p) => ({ user: p.user, debt: debt(m, p), value: collateralValue(m, p), healthFactor: healthFactor(m, p) as number })),
      suppliers: supplierShares(book, ps, m.loan.decimals),
    });
  }
  const byToken = new Map<string, PreparedMarket[]>();
  for (const pm of markets) {
    const t = (pm.market.collateral as { address: string }).address;
    byToken.set(t, [...(byToken.get(t) ?? []), pm]);
  }
  return { book, markets, byToken: new Map([...byToken].sort(([a], [b]) => (a < b ? -1 : 1))) };
}

export interface PositionRun {
  user: string;
  debt: number;
  result: PositionResult;
}

export interface MarketRun {
  marketId: string;
  /** Debt that is liquidatable at the oracle, in loan tokens. */
  liquidatableDebt: number;
  /** Bad debt written off, in loan tokens. */
  realised: number;
  /** Shortfall left on the books, in loan tokens. */
  unrealised: number;
  outcomes: Record<Outcome, number>;
  positions: PositionRun[];
}

const emptyOutcomes = (): Record<Outcome, number> => ({ healthy: 0, liquidated: 0, "bad-debt": 0, unrealised: 0 });

/** Shares of a full liquidation liquidators can carry out, per market and borrower, for a thin exit. */
function thinFills(markets: PreparedMarket[], s: Scenario, depthUsd: number): Map<string, number> {
  const queue: { key: string; hf: number; usd: number }[] = [];
  for (const pm of markets) {
    for (const b of pm.borrowers) {
      const value = b.value * (1 - s.shock);
      if (value * pm.market.lltv >= b.debt) continue;
      // Dollars of collateral a full liquidation puts up for sale.
      queue.push({ key: `${pm.market.id}:${b.user}`, hf: b.healthFactor, usd: Math.min(value, b.debt * pm.lif) * pm.loanUsd });
    }
  }
  queue.sort((a, b) => a.hf - b.hf || (a.key < b.key ? -1 : 1));
  const fills = new Map<string, number>();
  let left = depthUsd;
  for (const q of queue) {
    const fill = q.usd <= 0 ? 1 : Math.min(1, left / q.usd);
    fills.set(q.key, fill);
    left = Math.max(0, left - fill * q.usd);
  }
  return fills;
}

/** Run one scenario on every market that takes the token. */
export function runScenario(prep: PreparedBook, cfg: LendingConfig, s: Scenario): MarketRun[] {
  const markets = prep.byToken.get(s.token) ?? [];
  const depth = cfg.thinExit.exitDepthUsd[s.token];
  const fills = s.kind === "thin" && depth !== undefined ? thinFills(markets, s, depth) : undefined;
  return markets.map((pm) => {
    const run: MarketRun = { marketId: pm.market.id, liquidatableDebt: 0, realised: 0, unrealised: 0, outcomes: emptyOutcomes(), positions: [] };
    for (const b of pm.borrowers) {
      const marketValue = b.value * (1 - s.shock);
      const oracleValue = s.kind === "hidden" ? b.value : marketValue;
      const fill = fills?.get(`${pm.market.id}:${b.user}`) ?? 1;
      const result = positionOutcome({ debt: b.debt, oracleValue, marketValue, lltv: pm.market.lltv, lif: pm.lif, fill });
      if (result.liquidatable) run.liquidatableDebt += b.debt;
      run.realised += result.realised;
      run.unrealised += result.unrealised;
      run.outcomes[result.outcome]++;
      run.positions.push({ user: b.user, debt: b.debt, result });
    }
    return run;
  });
}
