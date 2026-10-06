// What the snapshot needs beyond the events, read on chain at the snapshot block: each token's
// decimals and symbol, and each market's oracle price as Morpho reads it.

import { decodeAbiParameters, hexToString, type Hex } from "viem";
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
async function pool<T, R>(items: T[], fn: (t: T) => Promise<R>, width = 6): Promise<R[]> {
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
