// Accounting Monad has not seen yet: a liquidation that writes off bad debt, and a market with a fee.
// The events are built by hand with the amounts Morpho.sol would emit, derived from its formulas.

import { describe, expect, it } from "vitest";
import type { MorphoEvent } from "../src/events.js";
import { min, toAssetsUp, toSharesDown, toSharesUp, WAD, wMulDown, wTaylorCompounded } from "../src/math.js";
import { apply, newBook, type Book } from "../src/replay.js";

const ID = `0x${"ab".repeat(32)}`;
const ALICE = `0x${"a1".repeat(20)}`;
const BOB = `0x${"b0".repeat(20)}`;
const FEES = `0x${"fe".repeat(20)}`;
const E18 = 10n ** 18n;
/** About 3% a year, per second as a WAD. */
const RATE = 951_293_759n;

let logIndex = 0;
const at = (block: number, timestamp: number) => ({ block, timestamp, logIndex: logIndex++, tx: `0x${block.toString(16)}` });

/** A market with 1000 supplied by Alice, and Bob borrowing 800 against 1000 collateral. */
function seeded(): Book {
  const book = newBook();
  const ev: MorphoEvent[] = [
    { ...at(1, 1_000), kind: "CreateMarket", id: ID, loanToken: `0x${"01".repeat(20)}`, collateralToken: `0x${"02".repeat(20)}`, oracle: `0x${"03".repeat(20)}`, irm: `0x${"04".repeat(20)}`, lltv: 860_000_000_000_000_000n },
    { ...at(2, 1_000), kind: "Supply", id: ID, onBehalf: ALICE, assets: 1_000n * E18, shares: toSharesDown(1_000n * E18, 0n, 0n) },
    { ...at(3, 1_000), kind: "SupplyCollateral", id: ID, onBehalf: BOB, assets: 1_000n * E18 },
    { ...at(4, 1_000), kind: "Borrow", id: ID, onBehalf: BOB, assets: 800n * E18, shares: toSharesUp(800n * E18, 0n, 0n) },
  ];
  for (const e of ev) apply(book, e);
  return book;
}

function accrue(book: Book, block: number, timestamp: number) {
  const m = book.markets.get(ID)!;
  const interest = wMulDown(m.totalBorrowAssets, wTaylorCompounded(RATE, BigInt(timestamp - m.lastUpdate)));
  const feeAmount = wMulDown(interest, m.fee);
  const feeShares = m.fee === 0n ? 0n : toSharesDown(feeAmount, m.totalSupplyAssets + interest - feeAmount, m.totalSupplyShares);
  apply(book, { ...at(block, timestamp), kind: "AccrueInterest", id: ID, prevBorrowRate: RATE, interest, feeShares });
  return { interest, feeShares };
}

/** Bob's collateral is seized in full for part of his debt; Morpho writes off the rest. */
function liquidateAll(book: Book, forgeBadDebt = 0n) {
  const m = book.markets.get(ID)!;
  const bob = book.positions.get(ID)!.get(BOB)!;
  const repaidShares = bob.borrowShares / 2n;
  const repaidAssets = toAssetsUp(repaidShares, m.totalBorrowAssets, m.totalBorrowShares);
  const borrowAssetsAfter = m.totalBorrowAssets - repaidAssets;
  const borrowSharesAfter = m.totalBorrowShares - repaidShares;
  const badDebtShares = bob.borrowShares - repaidShares;
  const badDebtAssets = min(borrowAssetsAfter, toAssetsUp(badDebtShares, borrowAssetsAfter, borrowSharesAfter)) + forgeBadDebt;
  apply(book, { ...at(10, 2_000), kind: "AccrueInterest", id: ID, prevBorrowRate: 0n, interest: 0n, feeShares: 0n });
  apply(book, { ...at(10, 2_000), kind: "Liquidate", id: ID, borrower: BOB, repaidAssets, repaidShares, seizedAssets: bob.collateral, badDebtAssets, badDebtShares });
  return { repaidAssets, badDebtAssets };
}

describe("bad debt", () => {
  it("writes the rest of the debt off against the suppliers", () => {
    const book = seeded();
    const m = book.markets.get(ID)!;
    const priceBefore = (m.totalSupplyAssets * E18) / m.totalSupplyShares;
    const supplyBefore = m.totalSupplyAssets;
    const { badDebtAssets } = liquidateAll(book);
    const bob = book.positions.get(ID)!.get(BOB)!;
    expect(book.checks.failed).toEqual([]);
    expect(badDebtAssets).toBeGreaterThan(399n * E18);
    expect(bob).toEqual({ supplyShares: 0n, borrowShares: 0n, collateral: 0n });
    expect(m.totalBorrowShares).toBe(0n);
    expect(m.totalBorrowAssets).toBe(0n);
    expect(m.totalSupplyAssets).toBe(supplyBefore - badDebtAssets);
    expect(m.badDebtAssets).toBe(badDebtAssets);
    // Alice's shares are unchanged; what they are worth falls.
    expect((m.totalSupplyAssets * E18) / m.totalSupplyShares).toBeLessThan(priceBefore);
  });

  it("flags a Liquidate whose bad debt the replayed state does not give", () => {
    const book = seeded();
    liquidateAll(book, -1n);
    expect(book.checks.failed.map((f) => f.what)).toEqual(["badDebtAssets"]);
  });
});

describe("interest and fees", () => {
  it("accrues interest to both sides of the market", () => {
    const book = seeded();
    const { interest } = accrue(book, 5, 1_000 + 86_400);
    const m = book.markets.get(ID)!;
    expect(book.checks.failed).toEqual([]);
    // A day at 3% a year on 800.
    expect(Number(interest) / 1e18).toBeCloseTo((800 * 0.03) / 365, 3);
    expect(m.totalSupplyAssets).toBe(1_000n * E18 + interest);
    expect(m.totalBorrowAssets).toBe(800n * E18 + interest);
  });

  it("pays the fee in new supply shares to the fee recipient", () => {
    const book = seeded();
    apply(book, { ...at(5, 1_000), kind: "SetFeeRecipient", feeRecipient: FEES });
    apply(book, { ...at(5, 1_000), kind: "SetFee", id: ID, fee: WAD / 10n });
    const sharesBefore = book.markets.get(ID)!.totalSupplyShares;
    const { feeShares } = accrue(book, 6, 1_000 + 86_400);
    expect(book.checks.failed).toEqual([]);
    expect(feeShares).toBeGreaterThan(0n);
    expect(book.positions.get(ID)!.get(FEES)!.supplyShares).toBe(feeShares);
    expect(book.markets.get(ID)!.totalSupplyShares).toBe(sharesBefore + feeShares);
  });

  it("flags interest that does not follow from the previous rate", () => {
    const book = seeded();
    apply(book, { ...at(5, 1_000 + 86_400), kind: "AccrueInterest", id: ID, prevBorrowRate: RATE, interest: 1n, feeShares: 0n });
    expect(book.checks.failed.map((f) => f.what)).toEqual(["interest"]);
  });
});

describe("missing logs", () => {
  it("refuses to take more than a position holds", () => {
    const book = seeded();
    expect(() => apply(book, { ...at(9, 1_000), kind: "WithdrawCollateral", id: ID, onBehalf: ALICE, assets: 1n })).toThrow(/takes 1 from collateral 0/);
  });
});
