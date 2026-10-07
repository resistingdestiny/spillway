// The lending engine's outputs on the committed Monad snapshot, computed once at start.
//
// Everything the tools answer from the snapshot comes from here, through @spillway/lending's own
// functions. Nothing reads the network.

import { readFileSync } from "node:fs";
import {
  type AdaptersFile,
  type Curves,
  DEFAULT_CONFIG,
  type LendingBook,
  type LendingConfig,
  type PreparedBook,
  type PreparedMarket,
  type RawSnapshot,
  type VaultExposure,
  type VaultPrice,
  allCurves,
  coverTable,
  loadBook,
  marketCurves,
  pmlTable,
  prepare,
  priceVault,
  vaultExposure,
} from "@spillway/lending";

export const SNAPSHOT = new URL("../../fixtures/morpho/monad-2026-10-06.json", import.meta.url);
export const ADAPTERS = new URL("../../fixtures/morpho/monad-2026-10-06.adapters.json", import.meta.url);

export interface Engine {
  book: LendingBook;
  cfg: LendingConfig;
  prep: PreparedBook;
  curves: Curves;
  markets: ReturnType<typeof marketCurves>;
  pml: ReturnType<typeof pmlTable>;
  vaults: VaultExposure[];
  cover: ReturnType<typeof coverTable>;
  pricing: VaultPrice[];
  /** The Monad block the snapshot's state is read at (the block just after the API pull). */
  block: number;
  /** The snapshot's date, as "6 October 2026". */
  date: string;
}

export function loadEngine(snapshot: URL = SNAPSHOT, adapters: URL = ADAPTERS, cfg: LendingConfig = DEFAULT_CONFIG): Engine {
  const raw = JSON.parse(readFileSync(snapshot, "utf8")) as RawSnapshot;
  const adaptersFile = JSON.parse(readFileSync(adapters, "utf8")) as AdaptersFile;
  const book = loadBook(raw, adaptersFile);
  const prep = prepare(book, cfg);
  const curves = allCurves(prep, cfg);
  const vaults = vaultExposure(prep, cfg, curves);
  return {
    book,
    cfg,
    prep,
    curves,
    markets: marketCurves(prep, cfg, curves),
    pml: pmlTable(prep, cfg, curves),
    vaults,
    cover: coverTable(vaults, cfg, curves.shocks),
    pricing: vaults.map((v) => priceVault(prep, cfg, v)),
    block: book.blocks.to.number,
    date: new Date(book.takenAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }),
  };
}

export const pairOf = (pm: PreparedMarket) => `${pm.market.collateral?.symbol}/${pm.market.loan.symbol}`;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/**
 * A market from an id (or the start of one), a pair such as "wstETH/WETH", or a collateral symbol.
 * A pair or a symbol taken by several markets resolves to the one with the most debt.
 */
export function findMarket(e: Engine, query: string): PreparedMarket | null {
  const q = norm(query);
  const debt = (pm: PreparedMarket) => pm.borrowers.reduce((a, b) => a + b.debt, 0) * pm.loanUsd;
  const largest = (pms: PreparedMarket[]) => [...pms].sort((a, b) => debt(b) - debt(a) || (a.market.id < b.market.id ? -1 : 1))[0] ?? null;
  if (/^0x[0-9a-f]{6,64}$/.test(q)) return largest(e.prep.markets.filter((pm) => pm.market.id.startsWith(q)));
  const byPair = e.prep.markets.filter((pm) => norm(pairOf(pm)) === q);
  if (byPair.length > 0) return largest(byPair);
  return largest(e.prep.markets.filter((pm) => norm(pm.market.collateral?.symbol ?? "") === q));
}

/** A vault from its address or its name, whole or in part. Several matches resolve to the largest. */
export function findVault(e: Engine, query: string): VaultExposure | null {
  const q = query.trim().toLowerCase();
  if (q === "") return null;
  const exact = e.vaults.find((v) => v.vault === q || (v.name ?? "").toLowerCase() === q);
  if (exact) return exact;
  const words = q.split(/\s+/);
  // The list is sorted by supply, so the first match is the largest.
  return e.vaults.find((v) => words.every((w) => (v.name ?? "").toLowerCase().includes(w))) ?? null;
}
