// Provable shortfall: what a market's borrowers owe beyond their collateral, from Morpho's own position
// data at a given oracle price.
//
// When liquidators cannot sell (the thin exit), a loss stays unrealised: Morpho has not written it off,
// so the supply share price, the cover's usual trigger, has not moved. The loss is still there to read.
// For each borrower, Morpho stores borrowShares and collateral, and the market stores
// totalBorrowAssets and totalBorrowShares. So anyone can show that
//
//   shortfall = sum over borrowers of max(0, debt - collateral x price)
//
// by naming the borrowers. The cover contract computes the same figure on chain, so everything here
// is in loan-token base units, as integers, with Morpho's rounding:
//
// - debt = borrowShares.toAssetsUp(totalBorrowAssets, totalBorrowShares), that is
//   ceil(borrowShares * (totalBorrowAssets + 1) / (totalBorrowShares + 1e6)), Morpho's SharesMathLib
//   with its virtual assets and shares. Rounded up, as Morpho rounds what a borrower owes.
// - collateral value = floor(collateral * price / 1e36), Morpho's mulDivDown by ORACLE_PRICE_SCALE.
//   Rounded down, as Morpho rounds collateral when it checks health.
//
// These are the roundings Morpho's _isHealthy uses, so a borrower counts as short exactly when Morpho's
// own arithmetic says the collateral is worth less than the debt. Each borrower's figure is within 2
// base units of the exact one. The borrower list must be strictly ascending by address, which lets a
// contract reject a borrower named twice with one comparison per entry.
//
// On chain, read the market after accrueInterest, so totalBorrowAssets includes interest to the block.
// The snapshot's totals are the API's state at its timestamp.

import type { LendingBook, Market, Position } from "./snapshot.js";

/** Morpho Blue: ORACLE_PRICE_SCALE, VIRTUAL_SHARES and VIRTUAL_ASSETS (ConstantsLib, SharesMathLib). */
export const ORACLE_PRICE_SCALE = 10n ** 36n;
export const VIRTUAL_SHARES = 10n ** 6n;
export const VIRTUAL_ASSETS = 1n;
const WAD = 10n ** 18n;

const mulDivUp = (x: bigint, y: bigint, d: bigint) => (x * y + (d - 1n)) / d;
const mulDivDown = (x: bigint, y: bigint, d: bigint) => (x * y) / d;

/** A borrower's debt in loan base units, as Morpho computes it. */
export function debtAssets(m: Market, p: Position): bigint {
  return mulDivUp(p.borrowShares, m.totals.borrowAssets + VIRTUAL_ASSETS, m.totals.borrowShares + VIRTUAL_SHARES);
}

/** A borrower's collateral value in loan base units at `priceRaw` (Morpho's 1e36-scaled price). */
export function collateralAssets(p: Position, priceRaw: bigint): bigint {
  return mulDivDown(p.collateral, priceRaw, ORACLE_PRICE_SCALE);
}

/**
 * The oracle price after the issuer marks the collateral down by `markdown` (0 to 1). The markdown is
 * taken to 1e-9 and applied as price * (1e18 - m) / 1e18, rounded down.
 */
export function markedDown(priceRaw: bigint, markdown: number): bigint {
  if (markdown < 0 || markdown > 1) throw new Error(`markdown ${markdown} is outside 0 to 1`);
  const m = BigInt(Math.round(markdown * 1e9)) * 10n ** 9n;
  return (priceRaw * (WAD - m)) / WAD;
}

export interface BorrowerShortfall {
  user: string;
  debt: bigint;
  collateralValue: bigint;
  shortfall: bigint;
}

export interface Shortfall {
  marketId: string;
  priceRaw: bigint;
  /** Sum of the named borrowers' shortfalls, in loan base units. */
  shortfall: bigint;
  borrowers: BorrowerShortfall[];
}

function marketAndPositions(book: LendingBook, marketId: string): { market: Market; positions: Map<string, Position> } {
  const market = book.markets.find((m) => m.id === marketId);
  if (!market) throw new Error(`market ${marketId} is not in the book`);
  return { market, positions: new Map(book.positions.filter((p) => p.marketId === marketId).map((p) => [p.user, p])) };
}

/** Sum over the named borrowers of max(0, debt - collateral x price), in loan base units. */
export function provableShortfall(book: LendingBook, marketId: string, priceRaw: bigint, borrowers: string[]): Shortfall {
  const { market, positions } = marketAndPositions(book, marketId);
  const out: BorrowerShortfall[] = [];
  let total = 0n;
  let last = "";
  for (const raw of borrowers) {
    const user = raw.toLowerCase();
    if (user <= last) throw new Error(`borrowers must be strictly ascending: ${user} after ${last}`);
    last = user;
    const p = positions.get(user);
    // A borrower with no position owes nothing.
    const debt = p ? debtAssets(market, p) : 0n;
    const collateralValue = p ? collateralAssets(p, priceRaw) : 0n;
    const shortfall = debt > collateralValue ? debt - collateralValue : 0n;
    total += shortfall;
    out.push({ user, debt, collateralValue, shortfall });
  }
  return { marketId, priceRaw, shortfall: total, borrowers: out };
}

/**
 * The borrowers to name to prove a whole market's shortfall at `priceRaw`: every borrower whose debt
 * exceeds their collateral's value, in ascending order. Naming any other borrower adds nothing.
 */
export function shortfallWitness(book: LendingBook, marketId: string, priceRaw: bigint): Shortfall {
  const { market, positions } = marketAndPositions(book, marketId);
  const short = [...positions.values()]
    .filter((p) => p.borrowShares > 0n && debtAssets(market, p) > collateralAssets(p, priceRaw))
    .map((p) => p.user)
    .sort();
  return provableShortfall(book, marketId, priceRaw, short);
}
