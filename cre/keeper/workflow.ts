// The keeper workflow: on each cron fire, read what every listed policy is owed and, when
// any due clears the vault's dust threshold, send one report that claims it through the
// CRE forwarder and CoverKeeperReceiver.

import {
  bytesToHex,
  CronCapability,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  handler,
  LAST_FINALIZED_BLOCK_NUMBER,
  LATEST_BLOCK_NUMBER,
  prepareReportRequest,
  TxStatus,
  type Runtime,
} from "@chainlink/cre-sdk"
import { decodeFunctionResult, encodeFunctionData, zeroAddress, type Address, type Hex } from "viem"
import { decide, encodeReport, vaultAbi, type Claim, type Config, type Dues } from "./keeper"

type ViewName = "dustThreshold" | "claimable" | "claimableShortfall"

/** Calls one vault view through CRE's EVM read capability and decodes the uint256. */
function readVault(
  runtime: Runtime<Config>,
  evm: EVMClient,
  functionName: ViewName,
  args: readonly unknown[],
): bigint {
  const data = encodeFunctionData({ abi: vaultAbi, functionName, args } as never) as Hex
  const reply = evm
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: runtime.config.vault as Address, data }),
      blockNumber:
        runtime.config.readAt === "finalized" ? LAST_FINALIZED_BLOCK_NUMBER : LATEST_BLOCK_NUMBER,
    })
    .result()
  return decodeFunctionResult({ abi: vaultAbi, functionName, data: bytesToHex(reply.data) }) as bigint
}

export function onCron(runtime: Runtime<Config>): string {
  const config = runtime.config
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName })
  if (!network) throw new Error(`unknown chain ${config.chainSelectorName}`)
  const evm = new EVMClient(network.chainSelector.selector)

  const dust = readVault(runtime, evm, "dustThreshold", [])
  const claims: Claim[] = []
  for (const p of config.policies) {
    const policyId = BigInt(p.id)
    const borrowers = p.borrowers as Address[]
    const dues: Dues = {
      policyId,
      borrowers,
      shortfall: readVault(runtime, evm, "claimableShortfall", [policyId, borrowers]),
      realised: readVault(runtime, evm, "claimable", [policyId]),
    }
    const claim = decide(dues, dust)
    runtime.log(
      `policy ${p.id}: shortfall due ${dues.shortfall}, realised due ${dues.realised}, dust ${dust}: ` +
        (claim === null ? "nothing due" : claim.borrowers.length > 0 ? "claimShortfall" : "claim"),
    )
    if (claim !== null) claims.push(claim)
  }

  if (claims.length === 0) return "nothing due"
  const payload = encodeReport(claims)
  if (config.receiver === "") {
    runtime.log(`no receiver configured, report not sent: ${payload}`)
    return `due, not sent: ${claims.length} claim(s)`
  }

  const report = runtime.report(prepareReportRequest(payload)).result()
  const write = evm
    .writeReport(runtime, {
      receiver: config.receiver,
      report,
      gasConfig: { gasLimit: config.gasLimit },
    })
    .result()
  if (write.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`report write failed with status ${write.txStatus}: ${write.errorMessage ?? ""}`)
  }
  const tx = bytesToHex(write.txHash ?? new Uint8Array(32))
  // The forwarder does not revert when the receiver does. It records the failure, and the
  // capability reports it here (ReceiverContractExecutionStatus.REVERTED is 1). The
  // receiver catches failed claims itself, so a revert means the report was refused: a
  // wrong forwarder or workflow identity.
  if (write.receiverContractExecutionStatus === 1) {
    throw new Error(`receiver refused the report in ${tx}`)
  }
  runtime.log(`report sent: ${claims.length} claim(s) in ${tx}`)
  return `sent ${claims.length} claim(s): ${tx}`
}

export function initWorkflow(config: Config) {
  const cron = new CronCapability()
  return [handler(cron.trigger({ schedule: config.schedule }), onCron)]
}
