// One side of Perpl's order book, as a set of levels that follow the outside price.
//
// The snapshot gives price levels around the mark at one block. In a crash, market makers re-quote
// around the moving spot price, so we keep each level's distance from the anchor and its size, and
// re-anchor the whole side on spot every step. Forced selling eats levels from the top. Each eaten
// level refills toward its original size at an exponential rate, so fresh depth comes back near
// spot first, as re-quoting market makers would put it. Fills price at the levels, so the spread is
// paid.
//
// The book price (the real marker) is Perpl's own "impact price": the average price to trade a set
// notional into the book (Perpl docs, Price Indices: $1,000 / $2,000 / $5,000). It is measured
// against the untouched book, so a book nobody has hit reads as spot.

import type { EngineConfig } from "./config.js";
import type { Snapshot } from "./types.js";

/** Largest offset a level can sit at. A price can not go to zero on one order. */
const MAX_OFFSET = 0.95;
/** Spacing of the assumed tail levels beyond the deepest posted level. */
const TAIL_STEP = 0.001;

export class BookSide {
  readonly side: "bid" | "ask";
  /** Distance of each level from the anchor, as a fraction of the anchor. Ascending. */
  readonly offsets: number[];
  /** Asset units resting at each level in calm conditions, after the stress factor. */
  readonly original: number[];
  /** Asset units resting now. */
  readonly remaining: number[];
  readonly impactNotionalUsd: number;
  private restImpactOffset = 0;

  constructor(side: "bid" | "ask", offsets: number[], sizes: number[], impactNotionalUsd: number, anchor: number) {
    this.side = side;
    this.offsets = offsets;
    this.original = sizes.slice();
    this.remaining = sizes.slice();
    this.impactNotionalUsd = impactNotionalUsd;
    this.restImpactOffset = this.impactOffset(anchor);
  }

  static fromSnapshot(snapshot: Snapshot, side: "bid" | "ask", cfg: EngineConfig): BookSide {
    const anchor = snapshot.market.markPrice;
    const levels = side === "bid" ? snapshot.book.bids : snapshot.book.asks;
    const rows = levels
      .map(([price, size]) => ({
        offset: Math.max(0, side === "bid" ? (anchor - price) / anchor : (price - anchor) / anchor),
        size: size * cfg.book.stressDepthFactor,
      }))
      .filter((r) => r.size > 0 && r.offset < MAX_OFFSET)
      .sort((a, b) => a.offset - b.offset);

    // Assumed depth beyond the deepest posted level, in even steps.
    if (cfg.book.tailDepthUsdPerPct > 0) {
      const last = rows.length ? (rows[rows.length - 1] as { offset: number }).offset : 0;
      for (let off = last + TAIL_STEP; off < MAX_OFFSET; off += TAIL_STEP) {
        const price = side === "bid" ? anchor * (1 - off) : anchor * (1 + off);
        rows.push({ offset: off, size: (cfg.book.tailDepthUsdPerPct * (TAIL_STEP / 0.01)) / price });
      }
    }
    return new BookSide(
      side,
      rows.map((r) => r.offset),
      rows.map((r) => r.size),
      cfg.book.impactNotionalUsd,
      anchor,
    );
  }

  priceAt(spot: number, offset: number): number {
    return this.side === "bid" ? spot * (1 - offset) : spot * (1 + offset);
  }

  /** Each level recovers toward its original size with an e-folding time of `refillSeconds`. */
  refill(dtSeconds: number, refillSeconds: number): void {
    const k = refillSeconds <= 0 ? 1 : 1 - Math.exp(-dtSeconds / refillSeconds);
    for (let i = 0; i < this.remaining.length; i++) {
      const gap = (this.original[i] as number) - (this.remaining[i] as number);
      if (gap > 0) this.remaining[i] = (this.remaining[i] as number) + gap * k;
    }
  }

  /** Take up to `want` units from the top, no further than `maxOffset` from spot. */
  walk(want: number, spot: number, maxOffset = MAX_OFFSET): { filled: number; notional: number } {
    let left = want;
    let notional = 0;
    for (let i = 0; i < this.offsets.length && left > 0; i++) {
      const offset = this.offsets[i] as number;
      if (offset > maxOffset) break;
      const avail = this.remaining[i] as number;
      if (avail <= 0) continue;
      const take = Math.min(left, avail);
      this.remaining[i] = avail - take;
      notional += take * this.priceAt(spot, offset);
      left -= take;
    }
    return { filled: want - left, notional };
  }

  /** Average offset to trade the impact notional now, without changing the book. */
  impactOffset(spot: number): number {
    let usdLeft = this.impactNotionalUsd;
    let weighted = 0;
    let lastOffset = 0;
    for (let i = 0; i < this.offsets.length && usdLeft > 0; i++) {
      const avail = this.remaining[i] as number;
      if (avail <= 0) continue;
      const offset = this.offsets[i] as number;
      const usd = Math.min(usdLeft, avail * this.priceAt(spot, offset));
      weighted += usd * offset;
      usdLeft -= usd;
      lastOffset = offset;
    }
    if (this.offsets.length === 0) return 0;
    // An emptied book prices the missing part at the deepest level it reached, or the deepest level.
    if (usdLeft > 0) weighted += usdLeft * Math.max(lastOffset, this.offsets[this.offsets.length - 1] as number);
    return weighted / this.impactNotionalUsd;
  }

  /** Where Perpl's book trades now. Equals spot for an untouched book. */
  bookPrice(spot: number): number {
    return this.priceAt(spot, Math.max(0, this.impactOffset(spot) - this.restImpactOffset));
  }

  /** Dollars resting within `fraction` of spot right now. */
  depthUsd(spot: number, fraction = MAX_OFFSET): number {
    let usd = 0;
    for (let i = 0; i < this.offsets.length; i++) {
      const offset = this.offsets[i] as number;
      if (offset > fraction) break;
      usd += (this.remaining[i] as number) * this.priceAt(spot, offset);
    }
    return usd;
  }
}

/** Dollars of posted depth within `fraction` of the mark, straight from the snapshot. */
export function depthWithin(snapshot: Snapshot, side: "bid" | "ask", fraction: number): number {
  const anchor = snapshot.market.markPrice;
  const levels = side === "bid" ? snapshot.book.bids : snapshot.book.asks;
  let usd = 0;
  for (const [price, size] of levels) {
    const offset = side === "bid" ? (anchor - price) / anchor : (price - anchor) / anchor;
    if (offset <= fraction) usd += price * size;
  }
  return usd;
}
