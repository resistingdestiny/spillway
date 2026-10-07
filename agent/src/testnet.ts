// Live state of the cover on Monad testnet, through the web app's own reader (web/src/cover):
// one multicall for the vault, policy 1 and the replay market, and the claim events.

import { type PublicClient, createPublicClient, formatUnits, http } from "viem";
import { ADDR, CHAIN, EXPLORER, POLICY_ID, USD_DECIMALS } from "../../web/src/cover/config.js";
import { type ClaimEvent, claimsBetween, knownClaims, latest } from "../../web/src/cover/events.js";
import { readLive } from "../../web/src/cover/read.js";

export interface TestnetCover {
  network: "monad-testnet";
  block: number;
  /** Amounts in whole tUSD, the replay's test dollar. */
  vault: { address: string; freeCapital: number; activeLimit: number; capacity: number; paidOutTotal: number };
  policy: { id: number; holder: string; limit: number; deductible: number; paidSoFar: number; claimableNow: number; claimableShortfallNow: number; attached: boolean };
  market: { pair: string; replayOf: string; unhealthyBorrowers: number; borrowers: number; provableShortfall: number };
  lastClaim: { kind: "Claimed" | "ShortfallClaimed"; amount: number; shortfall: number | null; block: number; tx: string; url: string } | null;
}

export type TestnetReader = () => Promise<TestnetCover>;

const tusd = (x: bigint) => Number(formatUnits(x, USD_DECIMALS));

export function testnetClient(rpc?: string): PublicClient {
  return createPublicClient({ chain: CHAIN, transport: http(rpc, { retryCount: 1, timeout: 10_000 }) });
}

/** Reads the cover, at most once per `ttlMs`, so a burst of questions is one RPC call. */
export function testnetReader(client: PublicClient = testnetClient(), ttlMs = 15_000): TestnetReader {
  let cached: { at: number; value: Promise<TestnetCover> } | null = null;
  return () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.value;
    const value = readCover(client);
    cached = { at: Date.now(), value };
    // A failed read is not kept.
    value.catch(() => {
      cached = null;
    });
    return value;
  };
}

async function readCover(client: PublicClient): Promise<TestnetCover> {
  const live = await readLive(client, null);
  // History comes from the claim transactions the deployment file names; the RPC serves only the
  // last 100 blocks of logs.
  const [known, recent] = await Promise.all([knownClaims(client), claimsBetween(client, live.block - 99n, live.block).catch(() => [] as ClaimEvent[])]);
  const last = latest([...known, ...recent].filter((c) => c.policyId === POLICY_ID));
  const newest = [last.Claimed, last.ShortfallClaimed].filter((c): c is ClaimEvent => c !== null).sort((a, b) => Number(b.block - a.block))[0] ?? null;
  return {
    network: "monad-testnet",
    block: Number(live.block),
    vault: {
      address: ADDR.vault,
      freeCapital: tusd(live.vault.capital),
      activeLimit: tusd(live.vault.activeLimit),
      capacity: tusd(live.vault.capacity),
      paidOutTotal: tusd(live.vault.paidOut),
    },
    policy: {
      id: Number(POLICY_ID),
      holder: live.policy.holder,
      limit: tusd(live.policy.limit),
      deductible: tusd(live.policy.deductible),
      paidSoFar: tusd(live.policy.paid),
      claimableNow: tusd(live.claimable),
      claimableShortfallNow: tusd(live.claimableShortfall),
      attached: live.policy.attached,
    },
    market: {
      pair: "twstETH/tUSD",
      replayOf: "wstETH/WETH on Monad at block 111,058,632, at 1% scale",
      unhealthyBorrowers: live.unhealthy,
      borrowers: live.borrowing,
      provableShortfall: tusd(live.shortfall),
    },
    lastClaim: newest
      ? {
          kind: newest.kind,
          amount: tusd(newest.amount),
          shortfall: newest.shortfall === null ? null : tusd(newest.shortfall),
          block: Number(newest.block),
          tx: newest.tx,
          url: `${EXPLORER}/tx/${newest.tx}`,
        }
      : null,
  };
}
