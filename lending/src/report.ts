// Everything the lending stress test publishes, from one book and one config.
//
// Headline numbers are the thin exit: liquidators act only as far as Monad's exit depth lets them
// (src/exit.ts). "Liquidators always act" (the depeg scenario) is kept next to it for comparison, and
// the hidden loss (oracle holds) as a third view.
//
// - markets:   each market's stress curve when its collateral token falls, 0 to 100%.
// - pml:       collateral tokens ranked by the loss their failure would put on depositors, across
//              every market that takes them.
// - vaults:    the loss to each Morpho vault's depositors, by token and fall.
// - cover:     the cover limit that keeps a vault's depositors whole when one token falls by X.
// - positions: the single borrowers whose failure would cost suppliers the most.
//
// Dollar amounts use the API's USD price of each loan token, which the shock leaves alone: only the
// collateral moves. Dollars are rounded to the cent and fractions to 1e-9 so the output is stable.

import { lossByVault } from "./attribution.js";
import { type CollateralClass, type LendingConfig, classOf, shockMeaning } from "./config.js";
import { exitDepth } from "./exit.js";
import { thresholds } from "./model.js";
import { type PreparedBook, type PreparedMarket, type ScenarioKind, runScenario } from "./scenarios.js";

export const usd = (n: number) => Math.round(n * 100) / 100;
export const frac = (n: number) => Math.round(n * 1e9) / 1e9;

/** One market's losses over the shock grid, in loan tokens. */
interface Curve {
  liquidatable: number[];
  realised: number[];
  unrealised: number[];
}

/** Every market's curve for one token and scenario kind, by market id. */
function tokenCurves(prep: PreparedBook, cfg: LendingConfig, token: string, kind: ScenarioKind, shocks: number[]): Map<string, Curve> {
  const out = new Map<string, Curve>();
  for (const pm of prep.byToken.get(token) ?? []) out.set(pm.market.id, { liquidatable: [], realised: [], unrealised: [] });
  for (const shock of shocks) {
    for (const r of runScenario(prep, cfg, { kind, token, shock })) {
      const c = out.get(r.marketId) as Curve;
      c.liquidatable.push(r.liquidatableDebt);
      c.realised.push(r.realised);
      c.unrealised.push(r.unrealised);
    }
  }
  return out;
}

const loss = (c: Curve, i: number) => (c.realised[i] ?? 0) + (c.unrealised[i] ?? 0);
const firstAbove = (xs: number[], shocks: number[], floor: number): number | null => {
  const i = xs.findIndex((x) => x > floor);
  return i < 0 ? null : (shocks[i] as number);
};

export interface Curves {
  shocks: number[];
  depeg: Map<string, Map<string, Curve>>;
  hidden: Map<string, Map<string, Curve>>;
  thin: Map<string, Map<string, Curve>>;
}

/** Run every token through the thin exit, the depeg and the hidden loss on the grid. */
export function allCurves(prep: PreparedBook, cfg: LendingConfig, shocks: number[] = cfg.shockGrid): Curves {
  const out: Curves = { shocks, depeg: new Map(), hidden: new Map(), thin: new Map() };
  for (const token of prep.byToken.keys()) {
    out.thin.set(token, tokenCurves(prep, cfg, token, "thin", shocks));
    out.depeg.set(token, tokenCurves(prep, cfg, token, "depeg", shocks));
    out.hidden.set(token, tokenCurves(prep, cfg, token, "hidden", shocks));
  }
  return out;
}

const debtUsd = (pm: PreparedMarket) => pm.borrowers.reduce((a, b) => a + b.debt, 0) * pm.loanUsd;
const supplyUsd = (pm: PreparedMarket) => pm.suppliers.reduce((a, s) => a + s.supplied, 0) * pm.loanUsd;
const tokenOf = (pm: PreparedMarket) => pm.market.collateral as { address: string; symbol: string };

/** Loss to each vault (null for everyone else) in one market at one grid point, in USD. */
function vaultSplit(pm: PreparedMarket, c: Curve, i: number): Map<string | null, number> {
  const out = lossByVault(loss(c, i) * pm.loanUsd, pm.suppliers);
  return new Map([...out].sort(([a], [b]) => ((a ?? "~") < (b ?? "~") ? -1 : 1)));
}

export function marketCurves(prep: PreparedBook, cfg: LendingConfig, curves: Curves) {
  const shocks = curves.shocks;
  const at = cfg.reportShocks.map((s) => shocks.indexOf(s));
  return prep.markets
    .filter((pm) => pm.borrowers.length > 0)
    .map((pm) => {
      const m = pm.market;
      const token = tokenOf(pm).address;
      const d = curves.depeg.get(token)?.get(m.id) as Curve;
      const h = curves.hidden.get(token)?.get(m.id) as Curve;
      const t = curves.thin.get(token)?.get(m.id) as Curve;
      const toUsd = (xs: number[]) => xs.map((x) => usd(x * pm.loanUsd));
      const exit = exitDepth(tokenOf(pm), pm.lif, cfg);
      return {
        marketId: m.id,
        collateral: { address: token, symbol: tokenOf(pm).symbol },
        loan: { address: m.loan.address, symbol: m.loan.symbol },
        lltv: m.lltv,
        lif: frac(pm.lif),
        oracle: m.oracle,
        /** The oracle's kind where the research read it, null where it did not. */
        oracleKind: cfg.oracles[m.id] ?? null,
        /**
         * What a fall on this market's curves stands for. "issuer marks down": the oracle cannot see the
         * market, so the oracle moves only when the issuer's figure does. "market price falls": the
         * oracle follows the market. Null for an oracle not read.
         */
        shockMeans: shockMeaning(m.id, cfg),
        listed: m.listed,
        borrowers: pm.borrowers.length,
        suppliers: pm.suppliers.length,
        debtUsd: usd(debtUsd(pm)),
        supplyUsd: usd(supplyUsd(pm)),
        /** What liquidators can sell on Monad within this market's incentive. Null depth: not measured, no limit. */
        exit: { source: exit.source, maxLoss: frac(exit.maxLoss), depthUsd: exit.depthUsd === null ? null : usd(exit.depthUsd) },
        /** Smallest fall at which more than a dollar of debt is liquidatable, and at which suppliers lose more than a dollar. */
        firstLiquidation: firstAbove(d.liquidatable.map((x) => x * pm.loanUsd), shocks, 1),
        firstLoss: firstAbove(t.realised.map((_, i) => loss(t, i) * pm.loanUsd), shocks, 1),
        /** The same with liquidators always acting. */
        firstLossAlwaysAct: firstAbove(d.realised.map((_, i) => loss(d, i) * pm.loanUsd), shocks, 1),
        thin: { realisedUsd: toUsd(t.realised), unrealisedUsd: toUsd(t.unrealised) },
        depeg: { liquidatableUsd: toUsd(d.liquidatable), realisedUsd: toUsd(d.realised), unrealisedUsd: toUsd(d.unrealised) },
        hidden: { unrealisedUsd: toUsd(h.unrealised) },
        supplierShares: pm.suppliers.map((s) => ({ supplier: s.supplier, vault: s.vault, vaultName: s.vaultName, share: frac(s.share) })),
        /** The thin exit loss split across suppliers at each report shock, by vault, the rest as "others". */
        split: at.map((i) => {
          const byVault = vaultSplit(pm, t, i);
          return {
            shock: shocks[i] as number,
            vaults: [...byVault].filter(([v]) => v !== null).map(([v, l]) => ({ vault: v, name: prep.book.vaults.get(v as string)?.name ?? null, lossUsd: usd(l) })),
            othersUsd: usd(byVault.get(null) ?? 0),
          };
        }),
      };
    });
}

/** Total loss to depositors, in USD, when one token falls by shocks[i], over every market that takes it. */
function tokenLossUsd(prep: PreparedBook, curves: Map<string, Curve> | undefined, i: number): number {
  let total = 0;
  for (const [id, c] of curves ?? []) {
    const pm = prep.markets.find((m) => m.market.id === id) as PreparedMarket;
    total += loss(c, i) * pm.loanUsd;
  }
  return total;
}

export function pmlTable(prep: PreparedBook, cfg: LendingConfig, curves: Curves) {
  const shocks = curves.shocks;
  const rankAt = shocks.indexOf(cfg.pml.rankShock);
  const rows = [...prep.byToken].map(([token, pms]) => {
    const symbol = tokenOf(pms[0] as PreparedMarket).symbol;
    const t = curves.thin.get(token);
    const d = curves.depeg.get(token);
    const h = curves.hidden.get(token);
    const total = shocks.map((_, i) => tokenLossUsd(prep, t, i));
    const alwaysAct = shocks.map((_, i) => tokenLossUsd(prep, d, i));
    return {
      token,
      symbol,
      class: classOf(symbol, cfg) as CollateralClass,
      markets: pms.length,
      debtUsd: usd(pms.reduce((a, pm) => a + debtUsd(pm), 0)),
      supplyUsd: usd(pms.reduce((a, pm) => a + supplyUsd(pm), 0)),
      /** The loss its failure would put on depositors, at the ranking fall. */
      pmlUsd: usd(total[rankAt] ?? 0),
      /** Smallest fall at which depositors lose more than a dollar, in the thin exit and with liquidators always acting. */
      firstLoss: firstAbove(total, shocks, 1),
      firstLossAlwaysAct: firstAbove(alwaysAct, shocks, 1),
      lossUsd: cfg.reportShocks.map((s) => ({ shock: s, lossUsd: usd(total[shocks.indexOf(s)] ?? 0) })),
      alwaysActUsd: cfg.reportShocks.map((s) => ({ shock: s, lossUsd: usd(alwaysAct[shocks.indexOf(s)] ?? 0) })),
      hiddenUsd: cfg.reportShocks.map((s) => ({ shock: s, lossUsd: usd(tokenLossUsd(prep, h, shocks.indexOf(s))) })),
    };
  });
  return rows.sort((a, b) => b.pmlUsd - a.pmlUsd || b.debtUsd - a.debtUsd || (a.token < b.token ? -1 : 1)).map((r, i) => ({ rank: i + 1, ...r }));
}

/** Loss to one vault's depositors when `token` falls by shocks[i], in USD. */
function vaultLossUsd(prep: PreparedBook, curves: Map<string, Curve> | undefined, vault: string, i: number): number {
  let total = 0;
  for (const [id, c] of curves ?? []) {
    const pm = prep.markets.find((m) => m.market.id === id) as PreparedMarket;
    total += vaultSplit(pm, c, i).get(vault) ?? 0;
  }
  return total;
}

export function vaultExposure(prep: PreparedBook, cfg: LendingConfig, curves: Curves) {
  const shocks = curves.shocks;
  const vaults = new Map<string, { supplyUsd: number; markets: string[]; tokens: Set<string> }>();
  for (const pm of prep.markets) {
    for (const s of pm.suppliers) {
      if (!s.vault) continue;
      const v = vaults.get(s.vault) ?? { supplyUsd: 0, markets: [], tokens: new Set<string>() };
      v.supplyUsd += s.supplied * pm.loanUsd;
      v.markets.push(pm.market.id);
      if (pm.borrowers.length > 0) v.tokens.add(tokenOf(pm).address);
      vaults.set(s.vault, v);
    }
  }
  return [...vaults]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([address, v]) => {
      const info = prep.book.vaults.get(address);
      const byToken = [...v.tokens].sort().map((token) => {
        const symbol = tokenOf(prep.byToken.get(token)?.[0] as PreparedMarket).symbol;
        return {
          token,
          symbol,
          class: classOf(symbol, cfg),
          /** Thin exit loss on the shock grid. */
          lossUsd: shocks.map((_, i) => usd(vaultLossUsd(prep, curves.thin.get(token), address, i))),
          alwaysActUsd: shocks.map((_, i) => usd(vaultLossUsd(prep, curves.depeg.get(token), address, i))),
          hiddenUsd: shocks.map((_, i) => usd(vaultLossUsd(prep, curves.hidden.get(token), address, i))),
        };
      });
      return {
        vault: address,
        name: info?.name ?? null,
        curators: info?.curators ?? [],
        /** What the vault supplies to Morpho Blue markets in the snapshot, in USD. Idle cash is not seen. */
        supplyUsd: usd(v.supplyUsd),
        markets: v.markets.length,
        byToken,
      };
    })
    .sort((a, b) => b.supplyUsd - a.supplyUsd || (a.vault < b.vault ? -1 : 1));
}

export type VaultExposure = ReturnType<typeof vaultExposure>[number];

/**
 * The cover limit that keeps a vault's depositors whole when any one collateral token falls by
 * `shock`: the largest loss any single token's fall would cause, and which token that is.
 */
export function coverLimit(
  v: VaultExposure,
  shocks: number[],
  shock: number,
  kind: "thin" | "depeg" | "hidden" = "thin",
): { limitUsd: number; token: string | null; symbol: string | null } {
  const i = shocks.indexOf(shock);
  if (i < 0) throw new Error(`shock ${shock} is not on the grid`);
  let best = { limitUsd: 0, token: null as string | null, symbol: null as string | null };
  for (const t of v.byToken) {
    const l = (kind === "thin" ? t.lossUsd : kind === "depeg" ? t.alwaysActUsd : t.hiddenUsd)[i] ?? 0;
    if (l > best.limitUsd) best = { limitUsd: l, token: t.token, symbol: t.symbol };
  }
  return best;
}

export function coverTable(vaults: VaultExposure[], cfg: LendingConfig, shocks: number[]) {
  return vaults.map((v) => ({
    vault: v.vault,
    name: v.name,
    supplyUsd: v.supplyUsd,
    limits: cfg.reportShocks.map((s) => ({ shock: s, ...coverLimit(v, shocks, s) })),
    alwaysActLimits: cfg.reportShocks.map((s) => ({ shock: s, ...coverLimit(v, shocks, s, "depeg") })),
  }));
}

/** The single borrowers whose failure would cost suppliers the most, with the fall it would take. */
export function topPositions(prep: PreparedBook, cfg: LendingConfig) {
  const rows = prep.markets.flatMap((pm) =>
    pm.borrowers.map((b) => {
      const t = thresholds(b.debt, b.value, pm.market.lltv, pm.lif);
      return {
        marketId: pm.market.id,
        borrower: b.user,
        collateral: tokenOf(pm).symbol,
        loan: pm.market.loan.symbol,
        lltv: pm.market.lltv,
        debtUsd: usd(b.debt * pm.loanUsd),
        collateralUsd: usd(b.value * pm.loanUsd),
        healthFactor: frac(b.healthFactor),
        /** Fall in the collateral, against the loan token, at which the position can be liquidated. */
        fallToLiquidation: frac(t.liquidation),
        /** Fall at which liquidating it leaves bad debt, in one jump of the oracle. */
        fallToBadDebt: frac(t.badDebt),
        /** Suppliers' loss if the collateral is worth nothing. */
        lossAtFailureUsd: usd(b.debt * pm.loanUsd),
      };
    }),
  );
  return rows.sort((a, b) => b.debtUsd - a.debtUsd || (a.borrower < b.borrower ? -1 : 1)).slice(0, cfg.topPositions);
}
