// The replayed book as a `spillway.morpho-snapshot/1` file, the shape lending/src/snapshot.ts loads.
//
// Every amount, share, oracle price and token decimal comes from the chain: amounts from the replay,
// the rest from eth_call at the snapshot block. Position assets are converted from shares with
// Morpho's own rounding (supply down, borrow up) at the totals Morpho stores, so they exclude interest
// since each market's last update, as an eth_call to Morpho at that block would.
//
// Some fields are not on chain at all: USD prices, whether Morpho lists a market, an oracle's type
// and the Vault V2s that supply a market. Those are copied from a reference API snapshot when one is
// given (the labels), and left empty when not. `source.labels` names the file they came from.

import type { RawSnapshot } from "@spillway/lending";
import type { ChainMetadata, TokenInfo } from "./chain.js";
import { indexerConfig } from "./config.js";
import { toAssetsDown, toAssetsUp, WAD } from "./math.js";
import type { Book, MarketState, PositionState } from "./replay.js";

type RawMarket = RawSnapshot["markets"][number];
type RawPosition = RawSnapshot["positions"][number];

/** Morpho Blue: ORACLE_PRICE_SCALE = 1e36. */
const ORACLE_PRICE_SCALE = 10n ** 36n;
const ZERO = "0x0000000000000000000000000000000000000000";

export interface SnapshotSource {
  /** What fetched the logs: "hypersync" or "rpc". */
  logs: string;
  rpc: string;
  morpho: string;
  fromBlock: number;
  /** The reference snapshot the off-chain labels came from, or null. */
  labels: string | null;
}

export interface IndexedSnapshot extends RawSnapshot {
  source: SnapshotSource;
  counts: { markets: number; positions: number; events: number; checksPassed: number; checksFailed: number };
}

const units = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

/** Collateral value at the oracle times LLTV over debt, as Morpho's _isHealthy rounds it. */
export function healthFactor(m: MarketState, p: PositionState, borrowAssets: bigint, price: bigint | null): number | null {
  if (borrowAssets === 0n || price === null) return null;
  const maxBorrow = (((p.collateral * price) / ORACLE_PRICE_SCALE) * m.lltv) / WAD;
  return Number(maxBorrow) / Number(borrowAssets);
}

function asset(address: string, info: TokenInfo | null | undefined, label: RawMarket["loanAsset"] | null | undefined) {
  return {
    address,
    symbol: info?.symbol ?? label?.symbol ?? "UNKNOWN",
    // An address with no token behind it (idle markets) reads as 18 decimals, as Morpho's API reports it.
    decimals: info?.decimals ?? label?.decimals ?? 18,
    priceUsd: label?.priceUsd ?? null,
  };
}

function market(m: MarketState, meta: ChainMetadata, label: RawMarket | undefined, positions: PositionState[]): RawMarket {
  const loan = asset(m.loanToken, meta.tokens.get(m.loanToken), label?.loanAsset);
  const collateral = m.collateralToken === ZERO ? null : asset(m.collateralToken, meta.tokens.get(m.collateralToken), label?.collateralAsset);
  const price = meta.prices.get(m.id) ?? null;
  // Debt not covered by collateral at the oracle, the bad debt still to be written off.
  let unrealised = 0n;
  if (price !== null)
    for (const p of positions) {
      const debt = toAssetsUp(p.borrowShares, m.totalBorrowAssets, m.totalBorrowShares);
      const value = (p.collateral * price) / ORACLE_PRICE_SCALE;
      if (debt > value) unrealised += debt - value;
    }
  const usd = (raw: bigint, a: { decimals: number; priceUsd: number | null } | null) => (a?.priceUsd == null ? null : units(raw, a.decimals) * a.priceUsd);
  return {
    marketId: m.id,
    lltv: String(m.lltv),
    listed: label?.listed ?? false,
    oracle: m.oracle === ZERO ? null : { address: m.oracle, type: label?.oracle?.type ?? "Unknown" },
    collateralAsset: collateral,
    loanAsset: loan,
    state: {
      supplyAssets: String(m.totalSupplyAssets),
      supplyShares: String(m.totalSupplyShares),
      borrowAssets: String(m.totalBorrowAssets),
      borrowShares: String(m.totalBorrowShares),
      collateralAssets: collateral ? String(m.totalCollateral) : null,
      supplyAssetsUsd: usd(m.totalSupplyAssets, loan),
      borrowAssetsUsd: usd(m.totalBorrowAssets, loan),
      collateralAssetsUsd: collateral ? usd(m.totalCollateral, collateral) : null,
      price: price === null ? null : String(price),
      timestamp: m.lastUpdate,
    },
    badDebt: { usd: usd(unrealised, loan) ?? 0 },
    realizedBadDebt: { usd: usd(m.badDebtAssets, loan) ?? 0 },
    warnings: label?.warnings ?? [],
    supplyingVaultV2s: label?.supplyingVaultV2s ?? [],
  };
}

function position(m: MarketState, user: string, p: PositionState, price: bigint | null): RawPosition {
  const borrowAssets = toAssetsUp(p.borrowShares, m.totalBorrowAssets, m.totalBorrowShares);
  return {
    user: { address: user },
    market: { marketId: m.id },
    healthFactor: healthFactor(m, p, borrowAssets, price),
    state: {
      collateral: String(p.collateral),
      borrowAssets: String(borrowAssets),
      borrowShares: String(p.borrowShares),
      supplyAssets: String(toAssetsDown(p.supplyShares, m.totalSupplyAssets, m.totalSupplyShares)),
      supplyShares: String(p.supplyShares),
    },
  };
}

/** The book at the end of `at`, in the API snapshot's shape. Markets and positions in id and address order. */
export function buildSnapshot(book: Book, at: { number: number; timestamp: number }, meta: ChainMetadata, labels: RawSnapshot | null, source: SnapshotSource): IndexedSnapshot {
  const labelOf = new Map((labels?.markets ?? []).map((m) => [m.marketId.toLowerCase(), m]));
  const markets: RawMarket[] = [];
  const positions: RawPosition[] = [];
  for (const m of [...book.markets.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const open = [...(book.positions.get(m.id) ?? new Map<string, PositionState>())]
      .filter(([, p]) => p.supplyShares > 0n || p.borrowShares > 0n || p.collateral > 0n)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    markets.push(market(m, meta, labelOf.get(m.id), open.map(([, p]) => p)));
    for (const [user, p] of open) positions.push(position(m, user, p, meta.prices.get(m.id) ?? null));
  }
  return {
    schema: "spillway.morpho-snapshot/1",
    chainId: indexerConfig.chainId,
    source,
    takenAt: new Date(at.timestamp * 1000).toISOString(),
    // The state is exact at one block, so both ends of the API's window are that block.
    blockBefore: at,
    blockAfter: at,
    counts: { markets: markets.length, positions: positions.length, events: book.events, checksPassed: book.checks.passed, checksFailed: book.checks.failed.length },
    markets,
    positions,
  };
}
