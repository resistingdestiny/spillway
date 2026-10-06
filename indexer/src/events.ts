// Morpho Blue's events, decoded from raw logs.
//
// A raw log is the same whether it came from HyperSync or from eth_getLogs, so the replay never knows
// its source. Which fields are indexed (in topics) and which are in data follows
// morpho-blue/src/libraries/EventsLib.sol exactly: Withdraw, Borrow and WithdrawCollateral index the
// receiver and keep the caller in data; the others index the caller.

import { toEventSelector } from "viem";

/** One log as both sources return it. Hex strings are lower case. */
export interface RawLog {
  block: number;
  /** Unix seconds of the block. */
  timestamp: number;
  logIndex: number;
  tx: string;
  topics: string[];
  data: string;
}

export const SIGNATURES = {
  CreateMarket: "CreateMarket(bytes32,(address,address,address,address,uint256))",
  SetFee: "SetFee(bytes32,uint256)",
  SetFeeRecipient: "SetFeeRecipient(address)",
  AccrueInterest: "AccrueInterest(bytes32,uint256,uint256,uint256)",
  Supply: "Supply(bytes32,address,address,uint256,uint256)",
  Withdraw: "Withdraw(bytes32,address,address,address,uint256,uint256)",
  Borrow: "Borrow(bytes32,address,address,address,uint256,uint256)",
  Repay: "Repay(bytes32,address,address,uint256,uint256)",
  SupplyCollateral: "SupplyCollateral(bytes32,address,address,uint256)",
  WithdrawCollateral: "WithdrawCollateral(bytes32,address,address,address,uint256)",
  Liquidate: "Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)",
} as const;

export type EventName = keyof typeof SIGNATURES;

/** topic0 of each event, and the reverse map. */
export const TOPIC0 = Object.fromEntries(Object.entries(SIGNATURES).map(([n, s]) => [n, toEventSelector(s)])) as Record<EventName, string>;
const NAME_OF = new Map<string, EventName>(Object.entries(TOPIC0).map(([n, t]) => [t, n as EventName]));

interface At {
  block: number;
  timestamp: number;
  logIndex: number;
  tx: string;
}

export type MorphoEvent = At &
  (
    | { kind: "CreateMarket"; id: string; loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: bigint }
    | { kind: "SetFee"; id: string; fee: bigint }
    | { kind: "SetFeeRecipient"; feeRecipient: string }
    | { kind: "AccrueInterest"; id: string; prevBorrowRate: bigint; interest: bigint; feeShares: bigint }
    | { kind: "Supply" | "Withdraw" | "Borrow" | "Repay"; id: string; onBehalf: string; assets: bigint; shares: bigint }
    | { kind: "SupplyCollateral" | "WithdrawCollateral"; id: string; onBehalf: string; assets: bigint }
    | {
        kind: "Liquidate";
        id: string;
        borrower: string;
        repaidAssets: bigint;
        repaidShares: bigint;
        seizedAssets: bigint;
        badDebtAssets: bigint;
        badDebtShares: bigint;
      }
  );

/** The n-th 32-byte word of the data, as an unsigned integer. */
function word(data: string, n: number): bigint {
  const hex = data.slice(2 + 64 * n, 2 + 64 * (n + 1));
  if (hex.length !== 64) throw new Error(`log data has no word ${n}`);
  return BigInt(`0x${hex}`);
}

/** A 32-byte topic or word holding an address. */
const address = (h: string) => `0x${h.slice(-40)}`.toLowerCase();
const addrWord = (data: string, n: number) => address(data.slice(2 + 64 * n, 2 + 64 * (n + 1)));
const topic = (log: RawLog, n: number) => {
  const t = log.topics[n];
  if (!t) throw new Error(`log ${log.tx}:${log.logIndex} has no topic ${n}`);
  return t.toLowerCase();
};

/** Decode one log, or null for events the replay does not need (SetOwner, EnableIrm, FlashLoan...). */
export function decode(log: RawLog): MorphoEvent | null {
  const name = NAME_OF.get(log.topics[0]?.toLowerCase() ?? "");
  if (!name) return null;
  const at: At = { block: log.block, timestamp: log.timestamp, logIndex: log.logIndex, tx: log.tx };
  const d = log.data;
  switch (name) {
    case "CreateMarket":
      return {
        ...at,
        kind: name,
        id: topic(log, 1),
        loanToken: addrWord(d, 0),
        collateralToken: addrWord(d, 1),
        oracle: addrWord(d, 2),
        irm: addrWord(d, 3),
        lltv: word(d, 4),
      };
    case "SetFee":
      return { ...at, kind: name, id: topic(log, 1), fee: word(d, 0) };
    case "SetFeeRecipient":
      return { ...at, kind: name, feeRecipient: address(topic(log, 1)) };
    case "AccrueInterest":
      return { ...at, kind: name, id: topic(log, 1), prevBorrowRate: word(d, 0), interest: word(d, 1), feeShares: word(d, 2) };
    case "Supply":
    case "Repay":
      // topics: id, caller, onBehalf. data: assets, shares.
      return { ...at, kind: name, id: topic(log, 1), onBehalf: address(topic(log, 3)), assets: word(d, 0), shares: word(d, 1) };
    case "Withdraw":
    case "Borrow":
      // topics: id, onBehalf, receiver. data: caller, assets, shares.
      return { ...at, kind: name, id: topic(log, 1), onBehalf: address(topic(log, 2)), assets: word(d, 1), shares: word(d, 2) };
    case "SupplyCollateral":
      // topics: id, caller, onBehalf. data: assets.
      return { ...at, kind: name, id: topic(log, 1), onBehalf: address(topic(log, 3)), assets: word(d, 0) };
    case "WithdrawCollateral":
      // topics: id, onBehalf, receiver. data: caller, assets.
      return { ...at, kind: name, id: topic(log, 1), onBehalf: address(topic(log, 2)), assets: word(d, 1) };
    case "Liquidate":
      // topics: id, caller, borrower.
      return {
        ...at,
        kind: name,
        id: topic(log, 1),
        borrower: address(topic(log, 3)),
        repaidAssets: word(d, 0),
        repaidShares: word(d, 1),
        seizedAssets: word(d, 2),
        badDebtAssets: word(d, 3),
        badDebtShares: word(d, 4),
      };
  }
}

/** Chain order: by block, then by position in the block. */
export function byChainOrder(a: RawLog, b: RawLog): number {
  return a.block - b.block || a.logIndex - b.logIndex;
}
