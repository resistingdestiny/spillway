// Replays Morpho Blue's events into its storage: each market's totals and each position's supply
// shares, borrow shares and collateral, as morpho-blue/src/Morpho.sol updates them.
//
// Every event carries the assets and shares Morpho settled on, so state moves by exactly those. Two
// things change state without an event of their own: the fee recipient's shares, which arrive inside
// AccrueInterest, and the borrower's debt written off in Liquidate. Both are applied as Morpho does.
//
// Each event is also recomputed from the replayed totals (shares from assets with Morpho's rounding,
// interest from the previous rate and the seconds elapsed, fee shares, bad debt). A recomputation that
// disagrees means the replayed state has left the chain's, and is recorded as a failed check.

import type { MorphoEvent } from "./events.js";
import { min, toAssetsDown, toAssetsUp, toSharesDown, toSharesUp, wMulDown, wTaylorCompounded, zeroFloorSub } from "./math.js";

export interface MarketState {
  id: string;
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: bigint;
  createdBlock: number;
  fee: bigint;
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  /** Sum of the positions' collateral. Morpho stores no such total; the API reports one. */
  totalCollateral: bigint;
  /** Unix seconds of the last accrual, Morpho's `lastUpdate`. */
  lastUpdate: number;
  /** The rate of the last AccrueInterest, per second as a WAD: the rate for the period that ended then. */
  lastBorrowRate: bigint;
  /** Bad debt written off so far, from Liquidate. */
  badDebtAssets: bigint;
}

export interface PositionState {
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
}

export interface CheckFailure {
  kind: MorphoEvent["kind"];
  block: number;
  logIndex: number;
  tx: string;
  what: string;
  event: string;
  replayed: string;
}

export interface Book {
  /** The last block applied. */
  block: number;
  timestamp: number;
  feeRecipient: string;
  markets: Map<string, MarketState>;
  /** Market id to user to position. */
  positions: Map<string, Map<string, PositionState>>;
  events: number;
  checks: { passed: number; failed: CheckFailure[] };
}

export function newBook(): Book {
  return {
    block: 0,
    timestamp: 0,
    feeRecipient: "0x0000000000000000000000000000000000000000",
    markets: new Map(),
    positions: new Map(),
    events: 0,
    checks: { passed: 0, failed: [] },
  };
}

function marketOf(book: Book, e: MorphoEvent & { id: string }): MarketState {
  const m = book.markets.get(e.id);
  if (!m) throw new Error(`${e.kind} at ${e.block}:${e.logIndex} for market ${e.id}, which was never created`);
  return m;
}

function positionOf(book: Book, id: string, user: string): PositionState {
  const byUser = book.positions.get(id) ?? new Map<string, PositionState>();
  book.positions.set(id, byUser);
  const p = byUser.get(user) ?? { supplyShares: 0n, borrowShares: 0n, collateral: 0n };
  byUser.set(user, p);
  return p;
}

/** a - b, where a negative result means a log is missing or out of order. Morpho reverts there. */
function sub(a: bigint, b: bigint, e: MorphoEvent, what: string): bigint {
  if (b > a) throw new Error(`${e.kind} at ${e.block}:${e.logIndex} (${e.tx}) takes ${b} from ${what} ${a}`);
  return a - b;
}

function check(book: Book, e: MorphoEvent, what: string, ok: boolean, event: bigint, replayed: bigint) {
  if (ok) book.checks.passed++;
  else book.checks.failed.push({ kind: e.kind, block: e.block, logIndex: e.logIndex, tx: e.tx, what, event: String(event), replayed: String(replayed) });
}

/**
 * The event's assets and shares agree with the replayed totals under Morpho's rounding. The caller
 * fixes one of the two and Morpho derives the other, so one of the two conversions must match.
 */
function checkShares(book: Book, e: MorphoEvent, totalAssets: bigint, totalShares: bigint, assets: bigint, shares: bigint, sharesUp: boolean) {
  const fromAssets = sharesUp ? toSharesUp(assets, totalAssets, totalShares) : toSharesDown(assets, totalAssets, totalShares);
  const fromShares = sharesUp ? toAssetsDown(shares, totalAssets, totalShares) : toAssetsUp(shares, totalAssets, totalShares);
  check(book, e, "shares", shares === fromAssets || assets === fromShares, shares, fromAssets);
}

const ACCRUES = new Set<MorphoEvent["kind"]>(["SetFee", "Supply", "Withdraw", "Borrow", "Repay", "WithdrawCollateral", "Liquidate"]);

/** Apply one event. Events must come in chain order. */
export function apply(book: Book, e: MorphoEvent): void {
  if (e.block < book.block) throw new Error(`${e.kind} at ${e.block}:${e.logIndex} arrives after block ${book.block}`);
  book.block = e.block;
  book.timestamp = e.timestamp;
  book.events++;
  // Every entry point but supplyCollateral accrues interest first, which sets lastUpdate even when no
  // AccrueInterest is emitted: in a market with no IRM, or a second call in the same block.
  if (ACCRUES.has(e.kind) && "id" in e) marketOf(book, e).lastUpdate = e.timestamp;
  switch (e.kind) {
    case "CreateMarket": {
      if (book.markets.has(e.id)) throw new Error(`market ${e.id} created twice`);
      const { id, loanToken, collateralToken, oracle, irm, lltv } = e;
      book.markets.set(id, {
        id,
        loanToken,
        collateralToken,
        oracle,
        irm,
        lltv,
        createdBlock: e.block,
        fee: 0n,
        totalSupplyAssets: 0n,
        totalSupplyShares: 0n,
        totalBorrowAssets: 0n,
        totalBorrowShares: 0n,
        totalCollateral: 0n,
        lastUpdate: e.timestamp,
        lastBorrowRate: 0n,
        badDebtAssets: 0n,
      });
      return;
    }
    case "SetFeeRecipient":
      book.feeRecipient = e.feeRecipient;
      return;
    case "SetFee":
      // Morpho accrues at the old fee first; that accrual is its own AccrueInterest event, just before.
      marketOf(book, e).fee = e.fee;
      return;
    case "AccrueInterest": {
      const m = marketOf(book, e);
      const elapsed = BigInt(e.timestamp - m.lastUpdate);
      const interest = wMulDown(m.totalBorrowAssets, wTaylorCompounded(e.prevBorrowRate, elapsed));
      check(book, e, "interest", interest === e.interest, e.interest, interest);
      m.totalBorrowAssets += e.interest;
      m.totalSupplyAssets += e.interest;
      // Fee shares are priced against the supply before the fee, which the interest already includes.
      const feeAmount = wMulDown(e.interest, m.fee);
      const feeShares = m.fee === 0n ? 0n : toSharesDown(feeAmount, m.totalSupplyAssets - feeAmount, m.totalSupplyShares);
      check(book, e, "feeShares", feeShares === e.feeShares, e.feeShares, feeShares);
      if (e.feeShares > 0n) {
        positionOf(book, e.id, book.feeRecipient).supplyShares += e.feeShares;
        m.totalSupplyShares += e.feeShares;
      }
      m.lastUpdate = e.timestamp;
      m.lastBorrowRate = e.prevBorrowRate;
      return;
    }
    case "Supply": {
      const m = marketOf(book, e);
      checkShares(book, e, m.totalSupplyAssets, m.totalSupplyShares, e.assets, e.shares, false);
      positionOf(book, e.id, e.onBehalf).supplyShares += e.shares;
      m.totalSupplyShares += e.shares;
      m.totalSupplyAssets += e.assets;
      return;
    }
    case "Withdraw": {
      const m = marketOf(book, e);
      checkShares(book, e, m.totalSupplyAssets, m.totalSupplyShares, e.assets, e.shares, true);
      const p = positionOf(book, e.id, e.onBehalf);
      p.supplyShares = sub(p.supplyShares, e.shares, e, "supply shares");
      m.totalSupplyShares = sub(m.totalSupplyShares, e.shares, e, "total supply shares");
      m.totalSupplyAssets = sub(m.totalSupplyAssets, e.assets, e, "total supply assets");
      return;
    }
    case "Borrow": {
      const m = marketOf(book, e);
      checkShares(book, e, m.totalBorrowAssets, m.totalBorrowShares, e.assets, e.shares, true);
      positionOf(book, e.id, e.onBehalf).borrowShares += e.shares;
      m.totalBorrowShares += e.shares;
      m.totalBorrowAssets += e.assets;
      return;
    }
    case "Repay": {
      const m = marketOf(book, e);
      checkShares(book, e, m.totalBorrowAssets, m.totalBorrowShares, e.assets, e.shares, false);
      const p = positionOf(book, e.id, e.onBehalf);
      p.borrowShares = sub(p.borrowShares, e.shares, e, "borrow shares");
      m.totalBorrowShares = sub(m.totalBorrowShares, e.shares, e, "total borrow shares");
      // Rounding up can make the repaid assets exceed the total by one; Morpho floors at zero.
      m.totalBorrowAssets = zeroFloorSub(m.totalBorrowAssets, e.assets);
      return;
    }
    case "SupplyCollateral": {
      const m = marketOf(book, e);
      positionOf(book, e.id, e.onBehalf).collateral += e.assets;
      m.totalCollateral += e.assets;
      return;
    }
    case "WithdrawCollateral": {
      const m = marketOf(book, e);
      const p = positionOf(book, e.id, e.onBehalf);
      p.collateral = sub(p.collateral, e.assets, e, "collateral");
      m.totalCollateral = sub(m.totalCollateral, e.assets, e, "total collateral");
      return;
    }
    case "Liquidate":
      liquidate(book, e);
      return;
  }
}

function liquidate(book: Book, e: Extract<MorphoEvent, { kind: "Liquidate" }>) {
  const m = marketOf(book, e);
  const p = positionOf(book, e.id, e.borrower);
  // The seized amount depends on the oracle price, which no event records, so only the repaid side is recomputed.
  const repaid = toAssetsUp(e.repaidShares, m.totalBorrowAssets, m.totalBorrowShares);
  check(book, e, "repaidAssets", repaid === e.repaidAssets, e.repaidAssets, repaid);
  p.borrowShares = sub(p.borrowShares, e.repaidShares, e, "borrow shares");
  m.totalBorrowShares = sub(m.totalBorrowShares, e.repaidShares, e, "total borrow shares");
  m.totalBorrowAssets = zeroFloorSub(m.totalBorrowAssets, e.repaidAssets);
  p.collateral = sub(p.collateral, e.seizedAssets, e, "collateral");
  m.totalCollateral = sub(m.totalCollateral, e.seizedAssets, e, "total collateral");
  if (p.collateral !== 0n) {
    check(book, e, "badDebt", e.badDebtShares === 0n && e.badDebtAssets === 0n, e.badDebtShares, 0n);
    return;
  }
  // No collateral left: Morpho writes off the rest of the debt, and every supplier of the market bears it.
  check(book, e, "badDebtShares", e.badDebtShares === p.borrowShares, e.badDebtShares, p.borrowShares);
  const bad = min(m.totalBorrowAssets, toAssetsUp(e.badDebtShares, m.totalBorrowAssets, m.totalBorrowShares));
  check(book, e, "badDebtAssets", bad === e.badDebtAssets, e.badDebtAssets, bad);
  m.totalBorrowAssets = sub(m.totalBorrowAssets, e.badDebtAssets, e, "total borrow assets");
  m.totalSupplyAssets = sub(m.totalSupplyAssets, e.badDebtAssets, e, "total supply assets");
  m.totalBorrowShares = sub(m.totalBorrowShares, e.badDebtShares, e, "total borrow shares");
  m.badDebtAssets += e.badDebtAssets;
  p.borrowShares = 0n;
}
