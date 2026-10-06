// A typed view of a Morpho snapshot (`spillway.morpho-snapshot/1`), the file written by
// engine/scripts/snapshot-morpho.ts from Morpho's public GraphQL API.
//
// The API returns raw on-chain integers as JSON numbers when a double holds them exactly and as
// strings when it does not. Every amount is read into a bigint, so nothing is rounded on the way in.
// Conversion to whole tokens (a double) happens once, here, with each asset's own decimals.
//
// Addresses are lower-cased, and markets and positions are sorted, so that every output depends on
// the content of the file and not on the order the API returned it in.

export interface Asset {
  address: string;
  symbol: string;
  decimals: number;
  /** Morpho API's USD price, null for tokens it does not price (test tokens). */
  priceUsd: number | null;
}

export interface Vault {
  address: string;
  name: string;
  curators: string[];
}

export interface Market {
  id: string;
  listed: boolean;
  /** LLTV as a WAD (1e18 = 100%), as stored in Morpho. */
  lltvWad: bigint;
  lltv: number;
  oracle: { address: string; type: string } | null;
  /** Null for idle markets, which take no collateral and lend nothing. */
  collateral: Asset | null;
  loan: Asset;
  /**
   * The oracle's `price()` as Morpho reads it: loan base units per collateral base unit, scaled by
   * 1e36. So whole loan tokens per whole collateral token is priceRaw / 10^(36 + loanDecimals -
   * collateralDecimals).
   */
  priceRaw: bigint | null;
  /** Whole loan tokens per whole collateral token at the oracle. */
  price: number | null;
  totals: {
    supplyAssets: bigint;
    supplyShares: bigint;
    borrowAssets: bigint;
    borrowShares: bigint;
    collateral: bigint;
  };
  /** Morpho API's own USD figures, kept for comparison only. */
  apiUsd: { supply: number | null; borrow: number | null; collateral: number | null };
  /** Bad debt Morpho has already recorded in this market, in USD. */
  badDebtUsd: number;
  realizedBadDebtUsd: number;
  warnings: string[];
  /** Morpho Vault V2s the API lists as supplying this market. */
  vaults: Vault[];
  /** Unix seconds of the API's market state. */
  timestamp: number;
}

export interface Position {
  marketId: string;
  user: string;
  collateral: bigint;
  borrowAssets: bigint;
  borrowShares: bigint;
  supplyAssets: bigint;
  supplyShares: bigint;
  /** Morpho API's health factor, null for positions with no borrow. Kept for the fidelity check. */
  apiHealthFactor: number | null;
}

export interface Block {
  number: number;
  timestamp: number;
}

export interface LendingBook {
  chainId: number;
  takenAt: string;
  /** RPC blocks read just before and just after the API pull. The state lies between them. */
  blocks: { from: Block; to: Block };
  markets: Market[];
  positions: Position[];
  /** Every vault named anywhere in the snapshot, by address. */
  vaults: Map<string, Vault>;
  /**
   * Supplier address to the Vault V2 it supplies for. A Vault V2 supplies Morpho Blue through an
   * adapter contract, so the supplier on a market is the adapter, not the vault. Filled from an
   * adapters file (see scripts/resolve-adapters.ts), empty without one.
   */
  adapters: Map<string, string>;
}

type Raw = string | number | null | undefined;

/** An integer amount from the API, exact whether it came as a number or a string. Null reads as 0. */
export function int(v: Raw): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error(`amount ${v} is not an exact integer`);
  return BigInt(v);
}

/** Raw base units to whole tokens. */
export function units(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

const lower = (a: string) => a.toLowerCase();

interface RawAsset {
  address: string;
  symbol: string;
  decimals: number;
  priceUsd: number | null;
}

interface RawVault {
  address: string;
  name: string;
  curators?: { items?: { name: string }[] } | null;
}

interface RawMarket {
  marketId: string;
  lltv: Raw;
  listed: boolean;
  oracle: { address: string; type: string } | null;
  collateralAsset: RawAsset | null;
  loanAsset: RawAsset;
  state: Record<string, Raw>;
  badDebt?: { usd: number | null } | null;
  realizedBadDebt?: { usd: number | null } | null;
  warnings?: { type: string; level: string }[] | null;
  supplyingVaultV2s?: RawVault[] | null;
}

interface RawPosition {
  user: { address: string };
  market: { marketId: string };
  healthFactor: number | null;
  state: Record<string, Raw>;
}

export interface RawSnapshot {
  schema: string;
  chainId: number;
  takenAt: string;
  blockBefore: Block;
  blockAfter: Block;
  markets: RawMarket[];
  positions: RawPosition[];
}

/** An adapters file (scripts/resolve-adapters.ts): supplier address to parent vault, read on chain at one block. */
export interface AdaptersFile {
  schema: "spillway.morpho-adapters/1";
  block: number;
  adapters: Record<string, string>;
  /** Each parent vault's on-chain `name()`. Names a vault the API does not list on any market. */
  names: Record<string, string>;
}

const asset = (a: RawAsset): Asset => ({ address: lower(a.address), symbol: a.symbol, decimals: a.decimals, priceUsd: a.priceUsd });
const vault = (v: RawVault): Vault => ({ address: lower(v.address), name: v.name, curators: (v.curators?.items ?? []).map((c) => c.name) });
const num = (v: Raw): number | null => (v === null || v === undefined ? null : Number(v));

function market(m: RawMarket): Market {
  const s = m.state;
  const collateral = m.collateralAsset ? asset(m.collateralAsset) : null;
  const loan = asset(m.loanAsset);
  const priceRaw = s.price === null || s.price === undefined ? null : int(s.price);
  const price = priceRaw !== null && collateral ? Number(priceRaw) / 10 ** (36 + loan.decimals - collateral.decimals) : null;
  const lltvWad = int(m.lltv);
  return {
    id: lower(m.marketId),
    listed: m.listed,
    lltvWad,
    lltv: Number(lltvWad) / 1e18,
    oracle: m.oracle ? { address: lower(m.oracle.address), type: m.oracle.type } : null,
    collateral,
    loan,
    priceRaw,
    price,
    totals: {
      supplyAssets: int(s.supplyAssets),
      supplyShares: int(s.supplyShares),
      borrowAssets: int(s.borrowAssets),
      borrowShares: int(s.borrowShares),
      collateral: int(s.collateralAssets),
    },
    apiUsd: { supply: num(s.supplyAssetsUsd), borrow: num(s.borrowAssetsUsd), collateral: num(s.collateralAssetsUsd) },
    badDebtUsd: m.badDebt?.usd ?? 0,
    realizedBadDebtUsd: m.realizedBadDebt?.usd ?? 0,
    warnings: (m.warnings ?? []).map((w) => `${w.level}:${w.type}`).sort(),
    vaults: (m.supplyingVaultV2s ?? []).map(vault).sort((a, b) => (a.address < b.address ? -1 : 1)),
    timestamp: Number(s.timestamp ?? 0),
  };
}

function position(p: RawPosition): Position {
  const s = p.state;
  return {
    marketId: lower(p.market.marketId),
    user: lower(p.user.address),
    collateral: int(s.collateral),
    borrowAssets: int(s.borrowAssets),
    borrowShares: int(s.borrowShares),
    supplyAssets: int(s.supplyAssets),
    supplyShares: int(s.supplyShares),
    apiHealthFactor: p.healthFactor,
  };
}

export function loadBook(raw: RawSnapshot, adapters?: AdaptersFile): LendingBook {
  if (raw.schema !== "spillway.morpho-snapshot/1") throw new Error(`unknown snapshot schema ${raw.schema}`);
  const markets = raw.markets.map(market).sort((a, b) => (a.id < b.id ? -1 : 1));
  const ids = new Set(markets.map((m) => m.id));
  const positions = raw.positions
    .map(position)
    .filter((p) => ids.has(p.marketId))
    .sort((a, b) => (a.marketId === b.marketId ? (a.user < b.user ? -1 : 1) : a.marketId < b.marketId ? -1 : 1));
  const vaults = new Map<string, Vault>();
  for (const m of markets) for (const v of m.vaults) vaults.set(v.address, v);
  const adapterMap = new Map<string, string>();
  for (const [a, v] of Object.entries(adapters?.adapters ?? {}).sort()) adapterMap.set(lower(a), lower(v));
  for (const [v, name] of Object.entries(adapters?.names ?? {}).sort()) {
    if (!vaults.has(lower(v))) vaults.set(lower(v), { address: lower(v), name, curators: [] });
  }
  return {
    chainId: raw.chainId,
    takenAt: raw.takenAt,
    blocks: { from: raw.blockBefore, to: raw.blockAfter },
    markets,
    positions,
    vaults,
    adapters: adapterMap,
  };
}

/** Positions grouped by market id, in the book's order. */
export function positionsByMarket(book: LendingBook): Map<string, Position[]> {
  const out = new Map<string, Position[]>(book.markets.map((m) => [m.id, []]));
  for (const p of book.positions) out.get(p.marketId)?.push(p);
  return out;
}

/** The vault a supplier supplies for: itself if it is a listed vault, else its adapter's parent vault. */
export function vaultOf(book: LendingBook, supplier: string): Vault | null {
  return book.vaults.get(supplier) ?? book.vaults.get(book.adapters.get(supplier) ?? "") ?? null;
}
