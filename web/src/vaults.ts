// Vaults as a depositor sees them: what they hold, what a sudden drop in one collateral would cost
// them, and what cover for them costs. Read from the published lending bundle only, so the landing
// page and the checker need no engine.

import type { LendingBundle } from "@spillway/lending";
import { load } from "./load.js";

export const LENDING_BUNDLE = "data/lending/bundle.json";
/** The vault shown first, and the one whose wstETH/WETH book is replayed on Monad testnet. */
export const DEFAULT_VAULT = "Steakhouse Prime ETH";
/** Vaults smaller than this are left out of the picker. */
export const MIN_DEPOSITS = 100_000;
/** Largest drop on the checker's slider and chart. */
export const MAX_DROP = 0.5;
/** Cover above this yearly rate gets a plain reason next to it. */
export const HIGH_RATE = 0.1;

export interface TokenCurve {
  symbol: string;
  /** Loss to the vault's depositors in USD at each drop on `shocks`. */
  lossUsd: number[];
}

export interface Vault {
  address: string;
  name: string;
  curator: string | null;
  depositsUsd: number;
  /** Collateral that can cost depositors money, worst first. Never empty. */
  tokens: TokenCurve[];
  /** Yearly cover price as a share of deposits, or null if the vault is not priced. */
  rate: number | null;
  /** Most the cover pays for the whole vault, in USD. */
  limitUsd: number;
}

export interface Book {
  bundle: LendingBundle;
  shocks: number[];
  vaults: Vault[];
}

const at = (shocks: number[], xs: number[], drop: number): number => {
  // Linear between grid points, so the slider can move in half percents.
  const i = shocks.findIndex((s) => s >= drop - 1e-9);
  if (i <= 0) return xs[0] ?? 0;
  const s0 = shocks[i - 1] as number;
  const s1 = shocks[i] as number;
  const k = (drop - s0) / (s1 - s0);
  return (xs[i - 1] ?? 0) + ((xs[i] ?? 0) - (xs[i - 1] ?? 0)) * k;
};

/** Loss to a vault's depositors, in USD, when `token` suddenly drops by `drop`. */
export const lossAt = (book: Book, t: TokenCurve, drop: number): number => at(book.shocks, t.lossUsd, drop);

let loading: Promise<Book> | null = null;

export function loadBook(): Promise<Book> {
  const p = (loading ??= load<LendingBundle>(LENDING_BUNDLE).then((bundle) => {
    const shocks = bundle.shocks;
    const top = shocks.findIndex((s) => s >= MAX_DROP - 1e-9);
    const prices = new Map(bundle.pricing.map((p) => [p.vault, p] as const));
    const vaults = bundle.vaults
      .filter((v) => v.supplyUsd >= MIN_DEPOSITS && v.byToken.length > 0)
      .map((v): Vault => {
        const worst = (t: (typeof v.byToken)[number]) => t.lossUsd[top] ?? 0;
        const all = [...v.byToken].sort((a, b) => worst(b) - worst(a) || (a.symbol < b.symbol ? -1 : 1));
        const hurting = all.filter((t) => worst(t) > 0);
        const price = prices.get(v.vault);
        return {
          address: v.vault,
          name: v.name ?? `Vault ${v.vault.slice(0, 8)}`,
          curator: v.curators[0] ?? null,
          depositsUsd: v.supplyUsd,
          tokens: (hurting.length > 0 ? hurting : all.slice(0, 1)).map((t) => ({ symbol: t.symbol, lossUsd: t.lossUsd })),
          rate: price ? price.premiumOnSupply : null,
          limitUsd: price?.limitUsd ?? 0,
        };
      })
      .sort((a, b) => b.depositsUsd - a.depositsUsd);
    return { bundle, shocks, vaults };
  }));
  p.catch(() => (loading = null));
  return p;
}

export const findVault = (book: Book, name: string): Vault => (book.vaults.find((v) => v.name === name) ?? book.vaults[0]) as Vault;

/** What one depositor would see: their loss at a drop, what cover costs them and what it pays. */
export function quote(book: Book, v: Vault, t: TokenCurve, drop: number, deposit: number) {
  const vaultLoss = lossAt(book, t, drop);
  const share = v.depositsUsd > 0 ? vaultLoss / v.depositsUsd : 0;
  const yourLoss = deposit * share;
  const yourLimit = v.depositsUsd > 0 ? (deposit * v.limitUsd) / v.depositsUsd : 0;
  return {
    vaultLoss,
    share,
    yourLoss,
    yourLimit,
    premium: v.rate === null ? null : deposit * v.rate,
    payout: Math.min(yourLoss, yourLimit),
  };
}

/** The largest drop of `t` whose loss the vault's cover still pays in full. */
export function fullyPaidUpTo(book: Book, v: Vault, t: TokenCurve): number {
  let best = 0;
  book.shocks.forEach((s, i) => {
    if ((t.lossUsd[i] ?? 0) <= v.limitUsd + 1e-6) best = s;
  });
  return best;
}

/** The smallest drop of `t` at which the vault's depositors start to lose money, or null if none does. */
export function firstLoss(book: Book, t: TokenCurve): number | null {
  const i = t.lossUsd.findIndex((x) => x > 0);
  return i < 0 ? null : (book.shocks[i] ?? null);
}

/** Below 2% a year is low, up to 10% medium, above that high. */
export const riskLevel = (rate: number): "low" | "medium" | "high" => (rate < 0.02 ? "low" : rate <= HIGH_RATE ? "medium" : "high");

// ---------------------------------------------------------------- formatting

export const dollars = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
export const dollarsShort = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
};
export const percent = (x: number, places = 1): string => `${(x * 100).toFixed(places).replace(/\.0+$/, "")}%`;
/** A yearly rate, to two places below 1% so 0.71% does not read as 0.7%. */
export const yearly = (x: number): string => percent(x, x < 0.01 ? 2 : 1);
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
