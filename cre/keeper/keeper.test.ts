// Tests for the keeper on the CRE SDK's test runtime, with the vault mocked at its address.
// The live read path on Monad testnet is checked by keeper.live.test.ts.

import { describe, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { getNetwork } from "@chainlink/cre-sdk"
import {
  addContractMock,
  EvmMock,
  newTestRuntime,
  REPORT_METADATA_HEADER_LENGTH,
  test,
  type WriteReportMockInput,
} from "@chainlink/cre-sdk/test"
import { bytesToHex, decodeAbiParameters, getAddress, parseAbiParameters, type Address } from "viem"
import { configSchema, decide, encodeReport, readsPerRun, strictlyIncreasing, vaultAbi, type Config } from "./keeper"
import { initWorkflow, onCron } from "./workflow"

const config: Config = configSchema.parse(JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8")))
const deployment = JSON.parse(
  readFileSync(new URL("../../contracts/deployments/monad-testnet-lending.json", import.meta.url), "utf8"),
)
const B1 = "0x0000000000000000000000000000000000000001" as Address
const B2 = "0x0000000000000000000000000000000000000002" as Address
const DUST = 1_000_000n

describe("config.json", () => {
  test("names Monad testnet, the deployed vault and the deployed policy with its borrowers", () => {
    expect(config.chainSelectorName).toBe("monad-testnet")
    expect(getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName })).toBeDefined()
    expect(getAddress(config.vault)).toBe(getAddress(deployment.contracts.vault))
    expect(config.policies.map((p) => p.id)).toEqual([deployment.policy.id])
    expect(config.policies[0].borrowers).toEqual(deployment.borrowers)
  })

  test("gives a source for every setting", () => {
    const settings = Object.keys(config).filter((k) => k !== "sources")
    expect(Object.keys(config.sources).sort()).toEqual(settings.sort())
  })

  test("refuses unsorted borrowers and more policies than CRE's read limit allows", () => {
    const raw = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"))
    expect(configSchema.safeParse({ ...raw, policies: [{ id: 1, borrowers: [B2, B1] }] }).success).toBe(false)
    expect(configSchema.safeParse({ ...raw, policies: [{ id: 1, borrowers: [B1, B1] }] }).success).toBe(false)
    const many = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, borrowers: [] }))
    expect(readsPerRun(7)).toBe(15)
    expect(configSchema.safeParse({ ...raw, policies: many.slice(0, 7) }).success).toBe(true)
    expect(configSchema.safeParse({ ...raw, policies: many }).success).toBe(false)
  })
})

describe("decide", () => {
  const dues = (shortfall: bigint, realised: bigint) => ({ policyId: 1n, borrowers: [B1, B2], shortfall, realised })

  test("nothing due, or a due under the vault's dust threshold, sends nothing", () => {
    expect(decide(dues(0n, 0n), DUST)).toBeNull()
    expect(decide(dues(DUST - 1n, 0n), DUST)).toBeNull()
    expect(decide(dues(0n, 0n), 0n)).toBeNull()
  })

  test("an unrealised loss claims the shortfall over the listed borrowers", () => {
    expect(decide(dues(DUST, 0n), DUST)).toEqual({ policyId: 1n, borrowers: [B1, B2] })
    expect(decide(dues(5n * DUST, 2n * DUST), DUST)).toEqual({ policyId: 1n, borrowers: [B1, B2] })
  })

  test("a loss that is all realised claims it without the borrowers", () => {
    expect(decide(dues(3n * DUST, 3n * DUST), DUST)).toEqual({ policyId: 1n, borrowers: [] })
  })
})

describe("encodeReport", () => {
  test("matches Solidity's abi.encode of CoverKeeperReceiver.Claim[], as cast encodes it", () => {
    const claims = [
      { policyId: 1n, borrowers: [B1, B2] },
      { policyId: 2n, borrowers: [] },
    ]
    // cast abi-encode "f((uint256,address[])[])" "[(1,[0x..01,0x..02]),(2,[])]"
    expect(encodeReport(claims)).toBe(
      "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000",
    )
  })

  test("strictlyIncreasing compares addresses as numbers, whatever their case", () => {
    expect(strictlyIncreasing(deployment.borrowers)).toBe(true)
    expect(strictlyIncreasing(["0xAA00000000000000000000000000000000000000", "0xab00000000000000000000000000000000000000"])).toBe(true)
  })
})

describe("onCron", () => {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: "monad-testnet" })!
  const RECEIVER = "0x000000000000000000000000000000000000c0de" as Address

  /** The vault at its address, owing `shortfall` and `realised` on every policy. */
  function mockVault(shortfall: bigint, realised: bigint, receiverReverted = false) {
    const evm = EvmMock.testInstance(network.chainSelector.selector)
    const vault = addContractMock(evm, { address: config.vault as Address, abi: vaultAbi })
    const reads: string[] = []
    vault.dustThreshold = () => {
      reads.push("dustThreshold")
      return DUST
    }
    vault.claimableShortfall = (id: unknown, borrowers: unknown) => {
      reads.push(`claimableShortfall(${id}, ${(borrowers as Address[]).length} borrowers)`)
      return shortfall
    }
    vault.claimable = (id: unknown) => {
      reads.push(`claimable(${id})`)
      return realised
    }
    const writes: WriteReportMockInput[] = []
    const receiver = addContractMock(evm, { address: RECEIVER, abi: [] })
    receiver.writeReport = (input) => {
      writes.push(input)
      return {
        txStatus: "TX_STATUS_SUCCESS",
        txHash: Buffer.alloc(32, 0xab).toString("base64"),
        receiverContractExecutionStatus: receiverReverted
          ? "RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED"
          : "RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS",
      }
    }
    return { reads, writes }
  }

  /** The claims in a report as the receiver decodes them, after the 109-byte header. */
  function claimsIn(write: WriteReportMockInput) {
    const payload = bytesToHex(write.report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH))
    return decodeAbiParameters(parseAbiParameters("(uint256 policyId, address[] borrowers)[]"), payload)[0]
  }

  test("reads the dust threshold and both dues of policy 1, and reports nothing when nothing is due", () => {
    const { reads, writes } = mockVault(0n, 0n)
    const runtime = newTestRuntime<Config>(null, undefined, { ...config, receiver: RECEIVER })
    expect(onCron(runtime)).toBe("nothing due")
    expect(reads).toEqual(["dustThreshold", "claimableShortfall(1, 17 borrowers)", "claimable(1)"])
    expect(reads.length).toBe(readsPerRun(config.policies.length))
    expect(writes).toHaveLength(0)
    expect(runtime.getLogs().join("\n")).toContain("policy 1: shortfall due 0, realised due 0, dust 1000000: nothing due")
  })

  test("writes one report that claims the shortfall over the deployment's borrowers", () => {
    const { writes } = mockVault(57_634_680_000n, 0n)
    const runtime = newTestRuntime<Config>(null, undefined, { ...config, receiver: RECEIVER })
    expect(onCron(runtime)).toBe(`sent 1 claim(s): 0x${"ab".repeat(32)}`)
    expect(writes).toHaveLength(1)
    expect(bytesToHex(writes[0].receiver)).toBe(RECEIVER)
    expect(writes[0].gasConfig.gasLimit).toBe(BigInt(config.gasLimit))
    const [claim] = claimsIn(writes[0])
    expect(claim.policyId).toBe(1n)
    expect(claim.borrowers).toEqual(deployment.borrowers)
  })

  test("claims a realised loss without the borrowers", () => {
    const { writes } = mockVault(2n * DUST, 2n * DUST)
    onCron(newTestRuntime<Config>(null, undefined, { ...config, receiver: RECEIVER }))
    expect(claimsIn(writes[0])[0].borrowers).toEqual([])
  })

  test("fails the run when the receiver refuses the report", () => {
    mockVault(57_634_680_000n, 0n, true)
    const runtime = newTestRuntime<Config>(null, undefined, { ...config, receiver: RECEIVER })
    expect(() => onCron(runtime)).toThrow("receiver refused the report")
  })

  test("logs the report and writes nothing while no receiver is configured", () => {
    const { writes } = mockVault(57_634_680_000n, 0n)
    const runtime = newTestRuntime<Config>(null, undefined, config)
    expect(config.receiver).toBe("")
    expect(onCron(runtime)).toBe("due, not sent: 1 claim(s)")
    expect(writes).toHaveLength(0)
    expect(runtime.getLogs().join("\n")).toContain("no receiver configured, report not sent: 0x")
  })
})

describe("initWorkflow", () => {
  test("runs onCron on the configured schedule", () => {
    const handlers = initWorkflow(config)
    expect(handlers).toHaveLength(1)
    expect(handlers[0].fn).toBe(onCron)
    const trigger = handlers[0].trigger as { config?: { schedule?: string } }
    expect(trigger.config?.schedule).toBe(config.schedule)
  })
})
