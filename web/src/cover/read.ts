// Live state of the testnet cover, read in one multicall: the replay market on our Morpho
// Blue, the cover vault, policy 1 and, once a wallet is connected, its balances.

import { type Address, type ContractFunctionParameters, type PublicClient, createPublicClient, http, parseAbi } from "viem";
import { morphoAbi } from "../abi/morpho.js";
import { oracleAbi } from "../abi/oracle.js";
import { usdAbi } from "../abi/usd.js";
import { vaultAbi } from "../abi/vault.js";
import { ADDR, BORROWERS, CHAIN, LLTV, MARKET_ID, ORACLE_PRICE_SCALE, POLICY_ID, VIRTUAL_ASSETS, VIRTUAL_SHARES } from "./config.js";

/** Multicall3's own block getters. Not one of our contracts, so not in src/abi. */
const multicall3Abi = parseAbi(["function getBlockNumber() view returns (uint256)", "function getCurrentBlockTimestamp() view returns (uint256)"]);

export function publicClient(): PublicClient {
  return createPublicClient({ chain: CHAIN, transport: http(undefined, { retryCount: 1 }) });
}

export interface Mine {
  usd: bigint;
  allowance: bigint;
  shares: bigint;
  principal: bigint;
  premium: bigint;
}

export interface Live {
  block: bigint;
  timestamp: bigint;
  market: { supplyAssets: bigint; supplyShares: bigint; borrowAssets: bigint; borrowShares: bigint };
  oracle: bigint;
  sharePrice: bigint;
  shortfall: bigint;
  unhealthy: number;
  borrowing: number;
  vault: {
    capital: bigint;
    activeLimit: bigint;
    capacity: bigint;
    premiumBps: bigint;
    paidOut: bigint;
    premiumRate: bigint;
    totalShares: bigint;
    withdrawalNotice: bigint;
    dust: bigint;
  };
  policy: {
    holder: Address;
    end: bigint;
    attached: boolean;
    startSupplyAssets: bigint;
    startSupplyShares: bigint;
    coveredShares: bigint;
    limit: bigint;
    deductible: bigint;
    paid: bigint;
  };
  claimable: bigint;
  claimableShortfall: bigint;
  mine: Mine | null;
}

const mulDivUp = (x: bigint, y: bigint, d: bigint) => (x * y + d - 1n) / d;

/** Morpho's `toAssetsDown`, with its virtual shares and assets. */
export const toAssetsDown = (shares: bigint, assets: bigint, total: bigint) => (shares * (assets + VIRTUAL_ASSETS)) / (total + VIRTUAL_SHARES);

/**
 * Morpho's own health rule: the debt, rounded up, against the collateral at the oracle
 * price times the LLTV, both rounded down. From the stored totals, so interest since the
 * market's last update is left out; it only moves a borrower already at the line.
 */
function isUnhealthy(pos: { borrowShares: bigint; collateral: bigint }, m: Live["market"], price: bigint): boolean {
  if (pos.borrowShares === 0n) return false;
  const debt = mulDivUp(pos.borrowShares, m.borrowAssets + VIRTUAL_ASSETS, m.borrowShares + VIRTUAL_SHARES);
  const maxDebt = (((pos.collateral * price) / ORACLE_PRICE_SCALE) * LLTV) / 10n ** 18n;
  return debt > maxDebt;
}

/** One request: every figure the view shows, at one block. */
export async function readLive(client: PublicClient, account: Address | null): Promise<Live> {
  const mc = CHAIN.contracts.multicall3.address;
  const vault = { address: ADDR.vault, abi: vaultAbi } as const;
  const head = [
    { address: mc, abi: multicall3Abi, functionName: "getBlockNumber" },
    { address: mc, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" },
    { address: ADDR.morpho, abi: morphoAbi, functionName: "market", args: [MARKET_ID] },
    { address: ADDR.oracle, abi: oracleAbi, functionName: "price" },
    { ...vault, functionName: "sharePrice", args: [MARKET_ID] },
    { ...vault, functionName: "marketShortfall", args: [MARKET_ID, BORROWERS] },
    { ...vault, functionName: "freeCapital" },
    { ...vault, functionName: "activeLimit" },
    { ...vault, functionName: "capacity" },
    { ...vault, functionName: "premiumBps", args: [MARKET_ID] },
    { ...vault, functionName: "paidOut" },
    { ...vault, functionName: "premiumRate" },
    { ...vault, functionName: "totalShares" },
    { ...vault, functionName: "withdrawalNotice" },
    { ...vault, functionName: "dustThreshold" },
    { ...vault, functionName: "policy", args: [POLICY_ID] },
    { ...vault, functionName: "claimable", args: [POLICY_ID] },
    { ...vault, functionName: "claimableShortfall", args: [POLICY_ID, BORROWERS] },
  ] as const;
  const positions = BORROWERS.map((b) => ({ address: ADDR.morpho, abi: morphoAbi, functionName: "position", args: [MARKET_ID, b] }) as const);
  const mine = account
    ? ([
        { address: ADDR.usd, abi: usdAbi, functionName: "balanceOf", args: [account] },
        { address: ADDR.usd, abi: usdAbi, functionName: "allowance", args: [account, ADDR.vault] },
        { ...vault, functionName: "sharesOf", args: [account] },
        { ...vault, functionName: "principalOf", args: [account] },
        { ...vault, functionName: "pendingPremium", args: [account] },
      ] as const)
    : [];

  // batchSize 0 keeps it to one eth_call however long the calldata gets. The results are
  // typed by position below, since a spread of three lists loses viem's tuple inference.
  const contracts = [...head, ...positions, ...mine] as ContractFunctionParameters[];
  const r = await client.multicall({ contracts, allowFailure: false, batchSize: 0 });
  const [block, timestamp, mk, oracle, sharePrice, shortfall, capital, activeLimit, capacity, premiumBps, paidOut, premiumRate, totalShares, withdrawalNotice, dust, p, claimable, claimableShortfall] = r as unknown as [
    bigint, bigint, readonly [bigint, bigint, bigint, bigint, bigint, bigint], bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
    { holder: Address; end: bigint; attached: boolean; startSupplyAssets: bigint; startSupplyShares: bigint; coveredShares: bigint; limit: bigint; deductible: bigint; paid: bigint },
    bigint, bigint,
  ];
  const market = { supplyAssets: mk[0], supplyShares: mk[1], borrowAssets: mk[2], borrowShares: mk[3] };
  const pos = r.slice(head.length, head.length + positions.length) as unknown as (readonly [bigint, bigint, bigint])[];
  const borrowers = pos.map(([, borrowShares, collateral]) => ({ borrowShares, collateral }));
  const m = r.slice(head.length + positions.length) as unknown as bigint[];

  return {
    block,
    timestamp,
    market,
    oracle,
    sharePrice,
    shortfall,
    unhealthy: borrowers.filter((b) => isUnhealthy(b, market, oracle)).length,
    borrowing: borrowers.filter((b) => b.borrowShares > 0n).length,
    vault: { capital, activeLimit, capacity, premiumBps, paidOut, premiumRate, totalShares, withdrawalNotice, dust },
    policy: { ...p, end: BigInt(p.end) },
    claimable,
    claimableShortfall,
    mine: account ? { usd: m[0] ?? 0n, allowance: m[1] ?? 0n, shares: m[2] ?? 0n, principal: m[3] ?? 0n, premium: m[4] ?? 0n } : null,
  };
}
