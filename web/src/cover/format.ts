// Numbers and links as the testnet cover shows them.

import { type Address, type Hex, formatUnits } from "viem";
import { EXPLORER, USD_DECIMALS } from "./config.js";

/** tUSD base units as "57,634.68 tUSD". A nonzero amount too small for cents shows in full. */
export function tusd(x: bigint, digits = 2): string {
  const n = Number(formatUnits(x, USD_DECIMALS));
  const tiny = x !== 0n && Math.abs(n) < 10 ** -digits;
  const d = tiny ? USD_DECIMALS : digits;
  return `${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })} tUSD`;
}

export const int = (x: bigint | number): string => x.toLocaleString("en-US");
export const pct = (x: number, digits = 1): string => `${(x * 100).toFixed(digits)}%`;
export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const txUrl = (hash: Hex): string => `${EXPLORER}/tx/${hash}`;
export const addrUrl = (a: Address): string => `${EXPLORER}/address/${a}`;
export const txLink = (hash: Hex, text = "View on Monadscan"): string => `<a href="${txUrl(hash)}" target="_blank" rel="noopener">${text}</a>`;
export const addrLink = (a: Address): string => `<a href="${addrUrl(a)}" target="_blank" rel="noopener"><code>${shortAddr(a)}</code></a>`;

/** A unix time as "5 Nov 2026". */
export const day = (unix: bigint): string =>
  new Date(Number(unix) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
