// The report bundle: every output of the lending stress test and the manifest that reproduces it.
//
// Nothing here reads the clock or the network, and every list is sorted, so the same snapshot,
// adapters file, config and commit always give the same bytes.

import { createHash } from "node:crypto";
import type { LendingConfig } from "./config.js";
import { priceVault } from "./pricing.js";
import { allCurves, coverTable, marketCurves, pmlTable, topPositions, usd, vaultExposure } from "./report.js";
import { prepare } from "./scenarios.js";
import type { LendingBook } from "./snapshot.js";

export interface Manifest {
  /** SHA-256 of the snapshot file's bytes, and of the adapters file's. */
  fixture: { path: string; sha256: string };
  adapters: { path: string; sha256: string } | null;
  chainId: number;
  /** The Monad blocks read just before and just after the snapshot was pulled. */
  blocks: { from: number; to: number };
  takenAt: string;
  /** Git commit of the code that produced the bundle, and whether the tree had uncommitted changes. */
  commit: string;
  dirty: boolean;
  /** SHA-256 of the config as JSON. */
  configSha256: string;
  /** One line that reproduces the bundle byte for byte, at that commit. */
  command: string;
}

export const configHash = (cfg: LendingConfig) => createHash("sha256").update(JSON.stringify(cfg)).digest("hex");

export function buildLendingBundle(book: LendingBook, cfg: LendingConfig, manifest: Manifest) {
  const prep = prepare(book, cfg);
  const curves = allCurves(prep, cfg);
  const markets = marketCurves(prep, cfg, curves);
  const pml = pmlTable(prep, cfg, curves);
  const vaults = vaultExposure(prep, cfg, curves);
  const cover = coverTable(vaults, cfg, curves.shocks);
  const pricing = vaults.map((v) => priceVault(prep, cfg, v));
  const positions = topPositions(prep, cfg);
  const biggest = [...markets].sort((a, b) => b.debtUsd - a.debtUsd || (a.marketId < b.marketId ? -1 : 1));
  const at = (xs: number[], s: number) => xs[curves.shocks.indexOf(s)] ?? 0;
  return {
    schema: "spillway.lending-bundle/1" as const,
    manifest,
    config: cfg,
    shocks: curves.shocks,
    summary: {
      markets: book.markets.length,
      marketsWithBorrowers: markets.length,
      positions: book.positions.length,
      borrowers: markets.reduce((a, m) => a + m.borrowers, 0),
      debtUsd: Math.round(markets.reduce((a, m) => a + m.debtUsd, 0) * 100) / 100,
      supplyUsd: Math.round(prep.markets.reduce((a, pm) => a + pm.suppliers.reduce((b, s) => b + s.supplied, 0) * pm.loanUsd, 0) * 100) / 100,
      vaultsNamed: vaults.length,
    },
    headline: {
      markets: biggest.slice(0, 5).map((m) => ({
        marketId: m.marketId,
        pair: `${m.collateral.symbol}/${m.loan.symbol}`,
        lltv: m.lltv,
        oracle: m.oracle?.type ?? null,
        oracleKind: m.oracleKind?.kind ?? null,
        shockMeans: m.shockMeans,
        debtUsd: m.debtUsd,
        firstLiquidation: m.firstLiquidation,
        exit: m.exit,
        firstLoss: m.firstLoss,
        firstLossAlwaysAct: m.firstLossAlwaysAct,
        lossUsd: cfg.reportShocks.map((s) => ({ shock: s, lossUsd: usd(at(m.thin.realisedUsd, s) + at(m.thin.unrealisedUsd, s)) })),
        alwaysActUsd: cfg.reportShocks.map((s) => ({ shock: s, lossUsd: usd(at(m.depeg.realisedUsd, s) + at(m.depeg.unrealisedUsd, s)) })),
      })),
      pml: pml.slice(0, 5),
      positions: positions.slice(0, 5),
    },
    markets,
    pml,
    vaults,
    cover,
    pricing,
    positions,
  };
}

export type LendingBundle = ReturnType<typeof buildLendingBundle>;
