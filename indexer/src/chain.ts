// What the replay reads on chain at the snapshot block, beyond the events: each token's decimals and
// symbol, each market's oracle price as Morpho reads it, each IRM's current rate, and Morpho's own
// storage for every market and position, to check the replay against.

import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, hexToString, parseAbi, type Hex } from "viem";
import { indexerConfig } from "./config.js";
import type { Book } from "./replay.js";
import { call } from "./rpc.js";

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

export interface ChainMetadata {
  block: number;
  /** By token address. Null for an address with no token behind it (the zero address of idle markets). */
  tokens: Map<string, TokenInfo | null>;
  /** IOracle.price() by market id, null when the market has no oracle or the call reverts. */
  prices: Map<string, bigint | null>;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const SELECTOR = { decimals: "0x313ce567", symbol: "0x95d89b41", price: "0xa035b1fe" };

/** A symbol returned as an ABI string, or as bytes32 by older tokens. */
function symbolOf(raw: string): string {
  try {
    return decodeAbiParameters([{ type: "string" }], raw as Hex)[0];
  } catch {
    return hexToString(raw as Hex).replace(/\0+$/, "");
  }
}

async function token(address: string, block: number): Promise<TokenInfo | null> {
  if (address === ZERO) return null;
  const [d, s] = await Promise.all([call(address, SELECTOR.decimals, block), call(address, SELECTOR.symbol, block)]);
  if (!d || d === "0x") return null;
  return { decimals: Number(BigInt(d)), symbol: s && s !== "0x" ? symbolOf(s) : "UNKNOWN" };
}

async function price(oracle: string, block: number): Promise<bigint | null> {
  if (oracle === ZERO) return null;
  const r = await call(oracle, SELECTOR.price, block);
  return r && r !== "0x" ? BigInt(r) : null;
}

/** Run `fn` over `items`, a few at a time, so the public RPC is not flooded. */
export async function pool<T, R>(items: T[], fn: (t: T) => Promise<R>, width = 4): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

export async function readMetadata(book: Book, block: number): Promise<ChainMetadata> {
  const markets = [...book.markets.values()];
  const addresses = [...new Set(markets.flatMap((m) => [m.loanToken, m.collateralToken]))].sort();
  const infos = await pool(addresses, (a) => token(a, block));
  const prices = await pool(markets, (m) => price(m.oracle, block));
  return {
    block,
    tokens: new Map(addresses.map((a, i) => [a, infos[i] ?? null])),
    prices: new Map(markets.map((m, i) => [m.id, prices[i] ?? null])),
  };
}

const MORPHO_ABI = parseAbi([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
]);
const IRM_ABI = parseAbi([
  "function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)",
]);

async function morpho<F extends "market" | "position">(functionName: F, args: readonly unknown[], block: number) {
  const data = encodeFunctionData({ abi: MORPHO_ABI, functionName, args } as never);
  const r = await call(indexerConfig.morpho.address, data, block);
  if (!r) throw new Error(`Morpho.${functionName}(${args.join(", ")}) failed at block ${block}`);
  return decodeFunctionResult({ abi: MORPHO_ABI, functionName, data: r as Hex } as never) as unknown as readonly bigint[];
}

export interface StorageDiff {
  marketId: string;
  user: string | null;
  field: string;
  storage: string;
  replay: string;
  /** Why they differ, when the cause is known. */
  cause?: string;
}

/**
 * Anyone may call Morpho.accrueInterest(). In a market with no IRM it moves lastUpdate and emits
 * nothing, so no log records it. Such a market never accrues interest, so no amount depends on it.
 */
const SILENT_ACCRUAL = "accrueInterest() on a market with no IRM moves lastUpdate without an event; no amount depends on it";

/**
 * Read Morpho's own storage at `block` for every market and every open position, and compare it with
 * the replay. Equal everywhere means the events, replayed, give exactly what the contract holds.
 */
export async function checkStorage(book: Book, block: number): Promise<{ markets: number; positions: number; diffs: StorageDiff[] }> {
  const diffs: StorageDiff[] = [];
  const markets = [...book.markets.values()];
  await pool(markets, async (m) => {
    const [tsa, tss, tba, tbs, lastUpdate, fee] = await morpho("market", [m.id], block);
    const pairs: [string, bigint | undefined, bigint][] = [
      ["totalSupplyAssets", tsa, m.totalSupplyAssets],
      ["totalSupplyShares", tss, m.totalSupplyShares],
      ["totalBorrowAssets", tba, m.totalBorrowAssets],
      ["totalBorrowShares", tbs, m.totalBorrowShares],
      ["lastUpdate", lastUpdate, BigInt(m.lastUpdate)],
      ["fee", fee, m.fee],
    ];
    for (const [field, storage, replay] of pairs) {
      if (storage === replay) continue;
      const cause = field === "lastUpdate" && m.irm === ZERO ? SILENT_ACCRUAL : undefined;
      diffs.push({ marketId: m.id, user: null, field, storage: String(storage), replay: String(replay), ...(cause ? { cause } : {}) });
    }
  });
  const open = [...book.positions].flatMap(([id, byUser]) => [...byUser].filter(([, p]) => p.supplyShares || p.borrowShares || p.collateral).map(([user, p]) => ({ id, user, p })));
  await pool(open, async ({ id, user, p }) => {
    const [supplyShares, borrowShares, collateral] = await morpho("position", [id, user], block);
    const pairs: [string, bigint | undefined, bigint][] = [
      ["supplyShares", supplyShares, p.supplyShares],
      ["borrowShares", borrowShares, p.borrowShares],
      ["collateral", collateral, p.collateral],
    ];
    for (const [field, storage, replay] of pairs) if (storage !== replay) diffs.push({ marketId: id, user, field, storage: String(storage), replay: String(replay) });
  });
  return { markets: markets.length, positions: open.length, diffs };
}

/** Each market's IRM borrowRateView at `block`: the mean per-second rate since the market's last update. */
export async function borrowRates(book: Book, block: number): Promise<Map<string, bigint>> {
  const markets = [...book.markets.values()].filter((m) => m.irm !== ZERO);
  const rates = await pool(markets, async (m) => {
    const data = encodeFunctionData({
      abi: IRM_ABI,
      functionName: "borrowRateView",
      args: [
        { loanToken: m.loanToken as Hex, collateralToken: m.collateralToken as Hex, oracle: m.oracle as Hex, irm: m.irm as Hex, lltv: m.lltv },
        {
          totalSupplyAssets: m.totalSupplyAssets,
          totalSupplyShares: m.totalSupplyShares,
          totalBorrowAssets: m.totalBorrowAssets,
          totalBorrowShares: m.totalBorrowShares,
          lastUpdate: BigInt(m.lastUpdate),
          fee: m.fee,
        },
      ],
    });
    const r = await call(m.irm, data, block);
    return r && r !== "0x" ? BigInt(r) : null;
  });
  const out = new Map<string, bigint>();
  markets.forEach((m, i) => {
    const r = rates[i];
    if (r !== null && r !== undefined) out.set(m.id, r);
  });
  return out;
}
