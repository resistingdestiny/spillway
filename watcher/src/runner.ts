// Scenario runner: plays an engine run's money flow onto the mock adapter, in time order.
//
//   1. Read the chain: insurance fund, what the vault can still pay, nothing pending.
//   2. Run the engine from that same fund and layer.
//   3. Send fund_income as adapter.fundInsurance and each fill's bad debt as
//      adapter.reportBadDebt, in the engine's order (see plan.ts for batching and rounding).
//   4. Wait for the keeper (watcher.ts, a separate process) to settle every shortfall the
//      vault can pay.
//   5. Call adapter.finalizeShortfall() if anything is still pending, so it is booked as ADL.
//
// As a command, against a deployment file (Monad testnet by default):
//
//   RUNNER_KEY_FILE=~/.secrets/spillway-deployer.env \
//   pnpm --filter @spillway/watcher runner --scenario oi10x-drop20 [--dry-run]
//
// Options:
//   --scenario <name> | --oi <multiple> [--drop <fraction>]   no --drop replays 10 Oct 2025
//   --deployment <file>   --rpc <url>   --snapshot <file>   --report <file>
//   --batch step|event|compact   compact folds the plan into a few transactions for a real network
//   --settle-timeout <seconds>   --dry-run (forecast and plan only, sends nothing)

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, type EngineConfig, type RunResult, type Snapshot } from "@spillway/engine";
import type { Hash } from "viem";
import { adapterAbi, mockUsdAbi } from "./abi.js";
import {
  type ChainState,
  type Deployment,
  MONAD_TESTNET_RPC,
  PACKAGE_DIR,
  type Public,
  type Wallet,
  accountFromKey,
  bigintReplacer,
  chainFor,
  layerCapacity,
  loadDeployment,
  loadDotEnv,
  loadKey,
  publicClientFor,
  readState,
  sleep,
  walletClientFor,
} from "./chain.js";
import { toDollars } from "./money.js";
import { type Batching, type Plan, type TxKind, type WaterfallTotals, planTransactions, replayWaterfall } from "./plan.js";
import { buildReport, compare, formatTable } from "./report.js";
import { type ScenarioSpec, adhocScenario, findScenario, loadSnapshot, runEngine } from "./scenario.js";

/**
 * Extra gas on top of the estimate for reportBadDebt. The keeper's settle() can land between
 * the estimate and the transaction. If it clears the pending shortfall, reportBadDebt writes
 * pendingShortfall from zero again, which costs 17,100 more gas than the estimate assumed
 * (SSTORE zero to non-zero 22,100 against 5,000). Without headroom the transaction runs out of
 * gas and reverts. Seen in the e2e at 10x open interest, and reproduced with cast: estimate
 * 39,074 with a shortfall pending, 56,174 once settle() has cleared it.
 */
export const BAD_DEBT_GAS_HEADROOM = 20_000n;

export interface RunnerContext {
  publicClient: Public;
  /** The adapter's runner account. */
  wallet: Wallet;
  deployment: Deployment;
  log?: (msg: string) => void;
}

export interface RunOptions {
  batching?: Batching;
  cfg?: EngineConfig;
  /** How long to wait for the keeper after the last transaction. */
  settleTimeoutMs?: number;
  pollMs?: number;
  dryRun?: boolean;
}

export type SentKind = TxKind | "mint" | "approve" | "finalizeShortfall";

export interface SentTx {
  kind: SentKind;
  units: bigint;
  hash: Hash;
  block: bigint;
  gasUsed: bigint;
}

export interface ScenarioRun {
  spec: ScenarioSpec;
  engine: RunResult;
  engineMs: number;
  /** Where the engine started: the chain's fund and the vault's capacity, in base units. */
  start: { fund: bigint; layerCapacity: bigint };
  plan: Plan;
  /** The contracts' arithmetic replayed on the rounded plan. The chain must match it exactly. */
  expected: WaterfallTotals;
  before: ChainState;
  after?: ChainState;
  sent: SentTx[];
  finalized: bigint;
  chainMs: number;
}

export async function runScenario(ctx: RunnerContext, spec: ScenarioSpec, snapshot: Snapshot, opts: RunOptions = {}): Promise<ScenarioRun> {
  const { publicClient, wallet, deployment: d } = ctx;
  const log = ctx.log ?? (() => {});
  const cfg = opts.cfg ?? DEFAULT_CONFIG;
  const pollMs = opts.pollMs ?? 500;
  const adapter = d.contracts.MockBackstopAdapter;
  const usd = d.contracts.MockUSD;

  const before = await readState(publicClient, d);
  if (before.pendingShortfall > 0n) {
    throw new Error(`a shortfall of ${toDollars(before.pendingShortfall)} is already pending; let the keeper settle it and finalize before a new run`);
  }
  const start = { fund: before.insuranceFund, layerCapacity: layerCapacity(before) };

  const t0 = Date.now();
  const engine = runEngine(snapshot, spec, cfg, { fundUsd: toDollars(start.fund), layerUsd: toDollars(start.layerCapacity) });
  const engineMs = Date.now() - t0;
  const plan = planTransactions(engine.events, opts.batching ?? "step", start.fund);
  const expected = replayWaterfall(plan.txs, start.fund, start.layerCapacity);
  log(`engine: ${spec.label}, band ${engine.totals.band}, ${plan.events.length} money events, ${plan.txs.length} transactions (${plan.batching})`);

  const run: ScenarioRun = { spec, engine, engineMs, start, plan, expected, before, sent: [], finalized: 0n, chainMs: 0 };
  if (opts.dryRun) return run;

  const t1 = Date.now();
  const me = wallet.account.address;
  const runner = await publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "runner" });
  if (runner.toLowerCase() !== me.toLowerCase()) throw new Error(`${me} is not the adapter's runner (${runner})`);

  const send = async (kind: SentKind, units: bigint, write: () => Promise<Hash>) => {
    const hash = await write();
    const r = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: Math.min(pollMs, 250) });
    if (r.status !== "success") {
      const sent = await publicClient.getTransaction({ hash });
      throw new Error(`${kind} reverted in ${hash} (gas used ${r.gasUsed} of limit ${sent.gas})`);
    }
    run.sent.push({ kind, units, hash, block: r.blockNumber, gasUsed: r.gasUsed });
  };

  // Income is paid in by the runner, so it needs the tokens and the allowance up front.
  const need = plan.txs.filter((x) => x.kind === "fundInsurance").reduce((s, x) => s + x.units, 0n);
  if (need > 0n) {
    const cap = await publicClient.readContract({ address: usd, abi: mockUsdAbi, functionName: "MAX_MINT" });
    let balance = await publicClient.readContract({ address: usd, abi: mockUsdAbi, functionName: "balanceOf", args: [me] });
    while (balance < need) {
      const chunk = need - balance < cap ? need - balance : cap;
      await send("mint", chunk, () => wallet.writeContract({ address: usd, abi: mockUsdAbi, functionName: "mint", args: [me, chunk] }));
      balance += chunk;
    }
    const allowance = await publicClient.readContract({ address: usd, abi: mockUsdAbi, functionName: "allowance", args: [me, adapter] });
    if (allowance < need) {
      await send("approve", need, () => wallet.writeContract({ address: usd, abi: mockUsdAbi, functionName: "approve", args: [adapter, need] }));
    }
  }

  for (const [i, tx] of plan.txs.entries()) {
    await send(tx.kind, tx.units, async () => {
      const req = { address: adapter, abi: adapterAbi, functionName: tx.kind, args: [tx.units], account: wallet.account } as const;
      const gas = await publicClient.estimateContractGas(req);
      return wallet.writeContract({ ...req, gas: tx.kind === "reportBadDebt" ? gas + BAD_DEBT_GAS_HEADROOM : gas });
    });
    if ((i + 1) % 50 === 0) log(`runner: ${i + 1}/${plan.txs.length} transactions`);
  }
  log(`runner: all ${plan.txs.length} transactions mined`);

  // Wait until the keeper has paid what the vault can pay. Finalizing earlier would book
  // shortfall as ADL that the layer should have covered, so a timeout stops the run instead.
  const deadline = Date.now() + (opts.settleTimeoutMs ?? 60_000);
  for (;;) {
    const s = await readState(publicClient, d);
    if (s.pendingShortfall === 0n || layerCapacity(s) === 0n) break;
    if (Date.now() > deadline) {
      throw new Error(`keeper has not settled ${toDollars(s.pendingShortfall)} of shortfall; not finalizing`);
    }
    await sleep(pollMs);
  }

  const pending = await publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "pendingShortfall" });
  if (pending > 0n) {
    await send("finalizeShortfall", pending, () => wallet.writeContract({ address: adapter, abi: adapterAbi, functionName: "finalizeShortfall" }));
    run.finalized = pending;
    log(`runner: finalized ${toDollars(pending)} of shortfall as ADL`);
  } else {
    log("runner: nothing left pending, no finalize needed");
  }

  run.after = await readState(publicClient, d);
  run.chainMs = Date.now() - t1;
  return run;
}

// --------------------------------------------------------------------------- CLI

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  loadDotEnv();
  const args = process.argv.slice(2);
  const deploymentPath = arg(args, "deployment") ?? process.env.DEPLOYMENT ?? `${PACKAGE_DIR}/deployments/monad-testnet.json`;
  const d = loadDeployment(deploymentPath);
  const rpc = arg(args, "rpc") ?? process.env.RPC_URL ?? d.rpcUrl ?? MONAD_TESTNET_RPC;
  const chain = chainFor(d.chainId, rpc);
  const pollMs = d.chainId === 31337 ? 100 : 1000;
  const publicClient = publicClientFor(chain, pollMs);
  const chainId = await publicClient.getChainId();
  if (chainId !== d.chainId) throw new Error(`${rpc} is chain ${chainId}, the deployment says ${d.chainId}`);

  const name = arg(args, "scenario");
  const oi = arg(args, "oi");
  const drop = arg(args, "drop");
  const spec = name ? findScenario(name) : oi ? adhocScenario(Number(oi), drop === undefined ? undefined : Number(drop)) : undefined;
  if (!spec) throw new Error("pass --scenario <name> or --oi <multiple> [--drop <fraction>]");
  const dryRun = args.includes("--dry-run");

  const snapshot = loadSnapshot(arg(args, "snapshot"));
  const wallet = walletClientFor(chain, accountFromKey(loadKey("RUNNER_KEY_FILE", ["RUNNER_PK", "DEPLOYER_PK"])), pollMs);
  const log = (m: string) => console.error(m);
  const batch = arg(args, "batch") as Batching | undefined;
  const timeout = arg(args, "settle-timeout");
  const run = await runScenario({ publicClient, wallet, deployment: d, log }, spec, snapshot, {
    batching: batch,
    dryRun,
    pollMs,
    settleTimeoutMs: timeout ? Number(timeout) * 1000 : undefined,
  });

  if (dryRun) {
    const t = run.engine.totals;
    console.log(
      JSON.stringify(
        { scenario: spec, start: run.start, forecast: { badDebt: t.badDebt, fundPaid: t.fundPaid, layerPaid: t.layerPaid, tradersLose: t.tradersLose, band: t.band }, expected: run.expected, transactions: run.plan.txs.length },
        bigintReplacer,
        2,
      ),
    );
    return;
  }
  const cmp = compare(run);
  console.log(formatTable(run, cmp));
  const reportPath = arg(args, "report");
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(buildReport(run, cmp, { network: d.network, chainId: d.chainId }), bigintReplacer, 2)}\n`);
  if (!cmp.pass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
