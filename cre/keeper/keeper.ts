// The keeper's rules, apart from the CRE runtime: which config it accepts, what it reads
// from the vault, when a policy is due and how a report is encoded for CoverKeeperReceiver.
// Every value comes from config.json, which names the source of each.

import { encodeAbiParameters, isAddress, parseAbi, parseAbiParameters, type Address, type Hex } from "viem"
import { z } from "zod"

const address = z.string().refine((s): boolean => isAddress(s, { strict: false }), "not an address")

/** One policy to watch and the borrowers its shortfall is proved over. */
const policySchema = z.object({
  id: z.number().int().positive(),
  borrowers: z.array(address).refine(strictlyIncreasing, "borrowers must be strictly increasing"),
})

export const configSchema = z
  .object({
    schedule: z.string(),
    chainSelectorName: z.string(),
    readAt: z.enum(["finalized", "latest"]),
    vault: address,
    receiver: z.union([z.literal(""), address]),
    gasLimit: z.string().regex(/^\d+$/),
    readLimit: z.number().int().positive(),
    policies: z.array(policySchema).min(1),
    forwarders: z.object({ simulation: address, production: address }),
    sources: z.record(z.string()),
  })
  .refine((c) => readsPerRun(c.policies.length) <= c.readLimit, {
    message: "too many policies for CRE's read limit in one run",
  })

export type Config = z.infer<typeof configSchema>
export type Policy = z.infer<typeof policySchema>

/** One read for the dust threshold, then `claimableShortfall` and `claimable` per policy. */
export function readsPerRun(policies: number): number {
  return 1 + 2 * policies
}

/** As `MorphoCoverVault._shortfall` requires: each address above the one before it. */
export function strictlyIncreasing(addresses: readonly string[]): boolean {
  for (let i = 1; i < addresses.length; i++) {
    if (BigInt(addresses[i]) <= BigInt(addresses[i - 1])) return false
  }
  return true
}

/** The vault functions the keeper reads. All are views. */
export const vaultAbi = parseAbi([
  "function dustThreshold() view returns (uint256)",
  "function claimable(uint256 policyId) view returns (uint256)",
  "function claimableShortfall(uint256 policyId, address[] borrowers) view returns (uint256)",
])

/** What a policy is owed now on each path, as the vault previews it. */
export interface Dues {
  policyId: bigint
  borrowers: Address[]
  /** `claimableShortfall`: the unrealised shortfall over the borrowers plus any realised loss. */
  shortfall: bigint
  /** `claimable`: the realised loss alone, from the fall in the supply share price. */
  realised: bigint
}

/** One claim in a report, as `CoverKeeperReceiver.Claim`. An empty list calls `claim`. */
export interface Claim {
  policyId: bigint
  borrowers: Address[]
}

/**
 * The claim to send for a policy, or null when nothing is due. The vault reverts a claim
 * below its dust threshold, so a due under it waits. The shortfall due already contains
 * the realised loss, so it is never below the realised due. When it is higher, the
 * borrowers carry an unrealised loss and the claim lists them. When the two are equal the
 * whole loss is realised and `claim` pays it without the borrower reads.
 */
export function decide(d: Dues, dustThreshold: bigint): Claim | null {
  const best = d.shortfall > d.realised ? d.shortfall : d.realised
  if (best === 0n || best < dustThreshold) return null
  return { policyId: d.policyId, borrowers: d.shortfall > d.realised ? d.borrowers : [] }
}

/** The report payload: `abi.encode(Claim[])`, decoded by `CoverKeeperReceiver.onReport`. */
export function encodeReport(claims: readonly Claim[]): Hex {
  return encodeAbiParameters(parseAbiParameters("(uint256 policyId, address[] borrowers)[]"), [
    claims.map((c) => ({ policyId: c.policyId, borrowers: c.borrowers })),
  ])
}
