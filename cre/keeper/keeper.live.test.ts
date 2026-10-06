// The keeper's read path on the real deployment. Runs the workflow's own onCron on the CRE
// SDK's test runtime, and answers each EVM read it makes with an eth_call to Monad testnet,
// all at one finalized block. Only the transport differs from `cre workflow simulate`:
// the calldata, the block choice, the decoding and the decision are the workflow's.
//
// Skipped unless KEEPER_LIVE=1, so `bun test` stays offline. Run it with `bun run live`.

import { describe, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { getNetwork } from "@chainlink/cre-sdk"
import { EvmMock, newTestRuntime, test } from "@chainlink/cre-sdk/test"
import { bytesToHex, type Hex } from "viem"
import { configSchema, readsPerRun, type Config } from "./keeper"
import { onCron } from "./workflow"

const config: Config = configSchema.parse(JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8")))
const rpc = (readFileSync(new URL("../project.yaml", import.meta.url), "utf8").match(/url:\s*(\S+)/) ?? [])[1]
const live = process.env.KEEPER_LIVE === "1"

/** One JSON-RPC call, synchronous because CRE capability mocks answer synchronously. */
function rpcCall(method: string, params: unknown[]): unknown {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  const out = Bun.spawnSync(["curl", "-sS", "-X", "POST", "-H", "content-type: application/json", "--data", body, rpc])
  if (out.exitCode !== 0) throw new Error(`${method} failed: ${out.stderr.toString()}`)
  const reply = JSON.parse(out.stdout.toString())
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`)
  return reply.result
}

describe.if(live)("on Monad testnet", () => {
  test("policy 1 has already been paid, so the keeper finds nothing due", () => {
    const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName })!
    const chainId = BigInt(rpcCall("eth_chainId", []) as string)
    expect(chainId).toBe(10143n)
    // The workflow reads at the last finalized block. Pin it once, so every read sees the
    // same state, as the DON's reads at one finalized height do.
    expect(config.readAt).toBe("finalized")
    const block = (rpcCall("eth_getBlockByNumber", ["finalized", false]) as { number: Hex }).number

    const evm = EvmMock.testInstance(network.chainSelector.selector)
    const calls: { to: Hex; data: Hex }[] = []
    evm.callContract = (req) => {
      // The workflow asks for the finalized block: BigInt sign -1, magnitude 3.
      expect(req.blockNumber?.sign).toBe(-1n)
      expect(Array.from(req.blockNumber?.absVal ?? [])).toEqual([3])
      const to = bytesToHex(req.call!.to)
      const data = bytesToHex(req.call!.data)
      calls.push({ to, data })
      const result = rpcCall("eth_call", [{ to, data }, block]) as Hex
      return { data: Buffer.from(result.slice(2), "hex").toString("base64") }
    }
    evm.writeReport = () => {
      throw new Error("nothing is due, so nothing should be written")
    }

    const runtime = newTestRuntime<Config>(null, undefined, config)
    const result = onCron(runtime)
    for (const line of runtime.getLogs()) console.log(line)
    console.log(`Monad testnet, finalized block ${BigInt(block)}, ${calls.length} reads of ${config.vault}`)

    expect(result).toBe("nothing due")
    expect(calls).toHaveLength(readsPerRun(config.policies.length))
    expect(calls.every((c) => c.to.toLowerCase() === config.vault.toLowerCase())).toBe(true)
    // Policy 1 was paid its shortfall. Since then interest grows the borrowers' debt and
    // the holder's supply alike, so what is still due moves by a few base units at most,
    // far under the vault's dust threshold of one tUSD.
    const line = runtime.getLogs().find((l) => l.includes("policy 1:")) ?? ""
    const [, shortfall, realised, dust] = line.match(/shortfall due (\d+), realised due (\d+), dust (\d+): nothing due/) ?? []
    expect(BigInt(dust)).toBe(1_000_000n)
    expect(BigInt(shortfall)).toBeLessThan(BigInt(dust))
    expect(BigInt(realised)).toBeLessThan(BigInt(dust))
  })
})
