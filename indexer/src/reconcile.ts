// Compare the replayed book with Morpho's API snapshot, field by field, and say why they differ.
//
// Shares and collateral only move with an event, so at any block between the API's two reads they
// must match the API exactly. Assets are another matter: the API reports each market's totals with
// interest accrued, virtually, from the market's last on-chain update to the moment it read the
// market (its `state.timestamp`), while Morpho stores them as of the last update. The gap should be
// the interest the market's IRM would charge over that time, which `expectedInterest` recomputes.

import type { RawSnapshot } from "@spillway/lending";
import { wMulDown, wTaylorCompounded } from "./math.js";
import type { Book } from "./replay.js";

const int = (v: string | number | null | undefined) => BigInt(v ?? 0);

export interface PositionDiff {
  marketId: string;
  user: string;
  field: "supplyShares" | "borrowShares" | "collateral" | "missing in API" | "missing in replay";
  api: string;
  replay: string;
}

export interface MarketRow {
  marketId: string;
  /** Shares and collateral equal the API's. */
  exact: boolean;
  lastUpdate: number;
  apiTimestamp: number;
  /** API minus replay. */
  supplyAssetsGap: string;
  borrowAssetsGap: string;
  /** Interest from lastUpdate to apiTimestamp at the IRM's rate, null without a rate. */
  expectedInterest: string | null;
  /** borrowAssetsGap - expectedInterest, as a fraction of borrowAssetsGap. */
  residual: number | null;
}

export interface Reconciliation {
  block: number;
  positions: { compared: number; exact: number; diffs: PositionDiff[] };
  markets: { compared: number; exact: number; missing: string[]; rows: MarketRow[] };
}

/** Morpho's interest on `borrowAssets` at a per-second `rate` over `seconds`, as _accrueInterest rounds it. */
export function expectedInterest(borrowAssets: bigint, rate: bigint, seconds: number): bigint {
  if (seconds <= 0) return 0n;
  return wMulDown(borrowAssets, wTaylorCompounded(rate, BigInt(seconds)));
}

const FIELDS = ["supplyShares", "borrowShares", "collateral"] as const;

/** The book as replayed to the end of `block`. `rates`: each market's IRM borrowRateView there, by market id. */
export function reconcile(block: number, book: Book, api: RawSnapshot, rates: Map<string, bigint> = new Map()): Reconciliation {
  const diffs: PositionDiff[] = [];
  const seen = new Set<string>();
  let exact = 0;
  for (const p of api.positions) {
    const id = p.market.marketId.toLowerCase();
    const user = p.user.address.toLowerCase();
    seen.add(`${id}:${user}`);
    const ours = book.positions.get(id)?.get(user);
    if (!ours) {
      diffs.push({ marketId: id, user, field: "missing in replay", api: JSON.stringify(p.state), replay: "" });
      continue;
    }
    const bad = FIELDS.filter((f) => int(p.state[f]) !== ours[f]);
    for (const f of bad) diffs.push({ marketId: id, user, field: f, api: String(int(p.state[f])), replay: String(ours[f]) });
    if (bad.length === 0) exact++;
  }
  for (const [id, byUser] of book.positions)
    for (const [user, p] of byUser)
      if ((p.supplyShares || p.borrowShares || p.collateral) && !seen.has(`${id}:${user}`))
        diffs.push({ marketId: id, user, field: "missing in API", api: "", replay: JSON.stringify({ supplyShares: String(p.supplyShares), borrowShares: String(p.borrowShares), collateral: String(p.collateral) }) });

  const rows: MarketRow[] = [];
  const missing: string[] = [];
  for (const a of api.markets) {
    const id = a.marketId.toLowerCase();
    const m = book.markets.get(id);
    if (!m) {
      missing.push(id);
      continue;
    }
    const s = a.state;
    const sameShares = int(s.supplyShares) === m.totalSupplyShares && int(s.borrowShares) === m.totalBorrowShares;
    const sameCollateral = s.collateralAssets === null || s.collateralAssets === undefined || int(s.collateralAssets) === m.totalCollateral;
    const borrowGap = int(s.borrowAssets) - m.totalBorrowAssets;
    const apiTimestamp = Number(s.timestamp ?? 0);
    const rate = rates.get(id);
    const interest = rate === undefined ? null : expectedInterest(m.totalBorrowAssets, rate, apiTimestamp - m.lastUpdate);
    rows.push({
      marketId: id,
      exact: sameShares && sameCollateral,
      lastUpdate: m.lastUpdate,
      apiTimestamp,
      supplyAssetsGap: String(int(s.supplyAssets) - m.totalSupplyAssets),
      borrowAssetsGap: String(borrowGap),
      expectedInterest: interest === null ? null : String(interest),
      residual: interest === null ? null : borrowGap === 0n ? (interest === 0n ? 0 : 1) : Number(borrowGap - interest) / Number(borrowGap),
    });
  }
  return {
    block,
    positions: { compared: api.positions.length, exact, diffs },
    markets: { compared: api.markets.length, exact: rows.filter((r) => r.exact).length, missing, rows: rows.sort((x, y) => (x.marketId < y.marketId ? -1 : 1)) },
  };
}
