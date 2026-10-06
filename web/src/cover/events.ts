// Claims paid by the vault, from its Claimed and ShortfallClaimed events. The public RPC
// serves logs over 100 blocks at most, so history comes from the claim transactions the
// deployment file names, and new claims from scanning each block since the last poll.

import { type Hex, type Log, type PublicClient, getAbiItem, parseEventLogs } from "viem";
import { vaultAbi } from "../abi/vault.js";
import { ADDR, KNOWN_CLAIMS, LOG_RANGE } from "./config.js";

export interface ClaimEvent {
  kind: "Claimed" | "ShortfallClaimed";
  policyId: bigint;
  amount: bigint;
  paidTotal: bigint;
  /** Market shortfall the claim proved. ShortfallClaimed only. */
  shortfall: bigint | null;
  tx: Hex;
  block: bigint;
}

const EVENTS = ["Claimed", "ShortfallClaimed"] as const;

function decode(logs: Log[]): ClaimEvent[] {
  return parseEventLogs({ abi: vaultAbi, logs, eventName: [...EVENTS] })
    .filter((l) => l.address.toLowerCase() === ADDR.vault.toLowerCase())
    .map((l) => ({
      kind: l.eventName,
      policyId: l.args.policyId,
      amount: l.args.amount,
      paidTotal: l.args.paidTotal,
      shortfall: l.eventName === "ShortfallClaimed" ? l.args.shortfall : null,
      tx: l.transactionHash,
      block: l.blockNumber,
    }));
}

/** Claims in the transactions the deployment file names. */
export async function knownClaims(client: PublicClient): Promise<ClaimEvent[]> {
  const receipts = await Promise.all(KNOWN_CLAIMS.map((hash) => client.getTransactionReceipt({ hash })));
  return receipts.flatMap((r) => decode(r.logs));
}

/** Claims in a transaction just sent from this page. */
export function claimsIn(logs: Log[]): ClaimEvent[] {
  return decode(logs);
}

/** Claims from `from` to `to`, clipped to the last 100 blocks the RPC will serve. */
export async function claimsBetween(client: PublicClient, from: bigint, to: bigint): Promise<ClaimEvent[]> {
  const start = from > to - LOG_RANGE + 1n ? from : to - LOG_RANGE + 1n;
  if (start > to) return [];
  const logs = await client.getLogs({
    address: ADDR.vault,
    events: EVENTS.map((name) => getAbiItem({ abi: vaultAbi, name })),
    fromBlock: start,
    toBlock: to,
  });
  return decode(logs);
}

/** The latest of each kind, newest first, with duplicates (same transaction) dropped. */
export function latest(events: ClaimEvent[]): { Claimed: ClaimEvent | null; ShortfallClaimed: ClaimEvent | null } {
  const sorted = [...new Map(events.map((e) => [`${e.tx}:${e.kind}`, e])).values()].sort((a, b) => Number(b.block - a.block));
  return {
    Claimed: sorted.find((e) => e.kind === "Claimed") ?? null,
    ShortfallClaimed: sorted.find((e) => e.kind === "ShortfallClaimed") ?? null,
  };
}
