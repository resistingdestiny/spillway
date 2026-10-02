// End to end on a local anvil: deploy, run each scenario, let the keeper settle, compare.
//
//   pnpm --filter @spillway/watcher e2e [--scenario <name>]... [--batch step|event]
//
// For each scenario, on one anvil started here on a free port:
//   1. Deploy MockUSD, MockBackstopAdapter (fund seeded with the snapshot's insurance fund) and
//      CoverVault (term starts now and runs 30 days, limit = engine layer.limitUsd, sponsor =
//      deployer). Fund the premium. An LP deposits the full limit.
//   2. Start the keeper (watcher.ts) as its own process, with its own key.
//   3. Run the scenario with the runner's key (runner.ts).
//   4. Wait for the keeper's payouts, stop it, compare chain totals with the engine, write
//      reports/<scenario>.json.
// Fresh contracts per scenario, so every run starts from the snapshot.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { DEFAULT_CONFIG, type Snapshot } from "@spillway/engine";
import { type Abi, type Address, type Hash, type Hex, getAddress, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { adapterAbi, mockUsdAbi, vaultAbi } from "./abi.js";
import {
  type Deployment,
  PACKAGE_DIR,
  type Public,
  REPO_DIR,
  type Wallet,
  bigintReplacer,
  chainFor,
  publicClientFor,
  sleep,
  walletClientFor,
} from "./chain.js";
import { formatUnits, toUnits } from "./money.js";
import type { Batching } from "./plan.js";
import { type GasSummary, buildReport, compare, formatTable, gasSummary } from "./report.js";
import { type ScenarioRun, runScenario } from "./runner.js";
import { DEFAULT_SNAPSHOT, SCENARIOS, type ScenarioSpec, findScenario, loadSnapshot } from "./scenario.js";

const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? join(homedir(), ".foundry", "bin");
const CONTRACTS_DIR = join(REPO_DIR, "contracts");
const REPORTS_DIR = join(PACKAGE_DIR, "reports");
/** Anvil's default dev mnemonic. These keys are public and only ever used on the local chain. */
const MNEMONIC = "test test test test test test test test test test test junk";
const TERM_SECONDS = 30n * 24n * 3600n;
const PREMIUM = 5_000_000_000n; // 5,000 tUSD, as in contracts/script/Deploy.s.sol
const POLL_MS = 100;

const tool = (bin: string) => (existsSync(join(FOUNDRY_BIN, bin)) ? join(FOUNDRY_BIN, bin) : bin);

// ---------------------------------------------------------------------- artifacts

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = join(CONTRACTS_DIR, "out", `${name}.sol`, `${name}.json`);
  if (!existsSync(path)) {
    console.error("contracts/out is missing, running forge build");
    execFileSync(tool("forge"), ["build"], { cwd: CONTRACTS_DIR, stdio: "inherit" });
  }
  const json = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

// -------------------------------------------------------------------------- anvil

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function startAnvil(): Promise<{ url: string; version: string; stop: () => void }> {
  const port = await freePort();
  const version = execFileSync(tool("anvil"), ["--version"], { encoding: "utf8" }).split("\n")[0] ?? "anvil";
  const proc = spawn(tool("anvil"), ["--host", "127.0.0.1", "--port", String(port), "--silent"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      if (res.ok) return { url, version, stop: () => proc.kill("SIGTERM") };
    } catch {
      // not up yet
    }
    if (proc.exitCode !== null) throw new Error(`anvil exited with ${proc.exitCode}`);
    await sleep(100);
  }
  proc.kill("SIGTERM");
  throw new Error("anvil did not start");
}

// ------------------------------------------------------------------------- deploy

interface Actors {
  deployer: Wallet;
  runner: Wallet;
  lp: Wallet;
  keeperKey: Hex;
}

async function deploy(pub: Public, a: Actors, snapshot: Snapshot): Promise<{ deployment: Deployment; gas: bigint }> {
  let gas = 0n;
  const wait = async (hash: Hash) => {
    const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    if (r.status !== "success") throw new Error(`setup transaction reverted: ${hash}`);
    gas += r.gasUsed;
    return r;
  };
  const create = async (name: string, args: readonly unknown[]) => {
    const { abi, bytecode } = artifact(name);
    const r = await wait(await a.deployer.deployContract({ abi, bytecode, args }));
    if (!r.contractAddress) throw new Error(`${name} has no address`);
    return { address: getAddress(r.contractAddress), block: r.blockNumber };
  };
  const mint = async (w: Wallet, usd: Address, amount: bigint) => {
    const cap = 100_000_000_000n;
    for (let left = amount; left > 0n; ) {
      const chunk = left < cap ? left : cap;
      await wait(await w.writeContract({ address: usd, abi: mockUsdAbi, functionName: "mint", args: [w.account.address, chunk] }));
      left -= chunk;
    }
  };

  const owner = a.deployer.account.address;
  const seed = toUnits(snapshot.market.insuranceFund);
  const limit = toUnits(DEFAULT_CONFIG.layer.limitUsd);

  const usd = await create("MockUSD", []);
  const adapter = await create("MockBackstopAdapter", [usd.address, BigInt(snapshot.market.perpId), owner]);
  await wait(await a.deployer.writeContract({ address: adapter.address, abi: adapterAbi, functionName: "setRunner", args: [a.runner.account.address] }));
  const termStart = (await pub.getBlock()).timestamp;
  const vault = await create("CoverVault", [usd.address, adapter.address, owner, termStart, termStart + TERM_SECONDS, limit, seed]);
  await wait(await a.deployer.writeContract({ address: adapter.address, abi: adapterAbi, functionName: "setVault", args: [vault.address] }));

  // Seed the insurance fund with the snapshot's, to the unit, and fund the premium.
  await mint(a.deployer, usd.address, seed + PREMIUM);
  await wait(await a.deployer.writeContract({ address: usd.address, abi: mockUsdAbi, functionName: "approve", args: [adapter.address, seed] }));
  await wait(await a.deployer.writeContract({ address: adapter.address, abi: adapterAbi, functionName: "fundInsurance", args: [seed] }));
  await wait(await a.deployer.writeContract({ address: usd.address, abi: mockUsdAbi, functionName: "approve", args: [vault.address, PREMIUM] }));
  await wait(await a.deployer.writeContract({ address: vault.address, abi: vaultAbi, functionName: "fundPremium", args: [PREMIUM] }));

  // One LP takes the whole layer.
  await mint(a.lp, usd.address, limit);
  await wait(await a.lp.writeContract({ address: usd.address, abi: mockUsdAbi, functionName: "approve", args: [vault.address, limit] }));
  await wait(await a.lp.writeContract({ address: vault.address, abi: vaultAbi, functionName: "deposit", args: [limit] }));

  const deployment: Deployment = {
    schema: "spillway.deployment/1",
    network: "anvil",
    chainId: await pub.getChainId(),
    deployBlock: Number(usd.block),
    contracts: { MockUSD: usd.address, MockBackstopAdapter: adapter.address, CoverVault: vault.address },
    roles: { owner, runner: a.runner.account.address, sponsor: owner },
  };
  return { deployment, gas };
}

// ------------------------------------------------------------------------- keeper

interface KeeperProcess {
  lines: Record<string, unknown>[];
  stop: () => Promise<void>;
}

async function startKeeper(url: string, deploymentPath: string, keyPath: string): Promise<KeeperProcess> {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", join(PACKAGE_DIR, "src", "watcher.ts"), "--deployment", deploymentPath, "--rpc", url, "--poll-ms", String(POLL_MS)],
    { cwd: PACKAGE_DIR, env: { ...process.env, KEEPER_KEY_FILE: keyPath }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const lines: Record<string, unknown>[] = [];
  let stderr = "";
  child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
  const ready = new Promise<void>((resolve, reject) => {
    createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        lines.push(entry);
        if (entry.type === "ready") resolve();
        if (entry.type === "error") console.error(`  keeper error: ${String(entry.message)}`);
      } catch {
        console.error(`  keeper: ${line}`);
      }
    });
    child.on("exit", (code) => reject(new Error(`keeper exited with ${code}: ${stderr.trim()}`)));
  });
  await ready;
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return {
    lines,
    stop: async () => {
      child.kill("SIGTERM");
      await exited;
    },
  };
}

// ----------------------------------------------------------------------- scenario

interface Outcome {
  spec: ScenarioSpec;
  run: ScenarioRun;
  pass: boolean;
  maxDiff: number;
  tolerance: number;
  gas: GasSummary;
  payouts: number;
}

async function runOne(url: string, version: string, spec: ScenarioSpec, snapshot: Snapshot, batching: Batching, work: string): Promise<Outcome> {
  const chain = chainFor(31337, url);
  const pub = publicClientFor(chain, POLL_MS);
  const hd = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
  const keeperHd = hd(3);
  const actors: Actors = {
    deployer: walletClientFor(chain, hd(0), POLL_MS),
    runner: walletClientFor(chain, hd(1), POLL_MS),
    lp: walletClientFor(chain, hd(2), POLL_MS),
    keeperKey: toHex(keeperHd.getHdKey().privateKey!),
  };

  console.log(`\n== ${spec.name}: ${spec.label}`);
  const { deployment, gas: setupGas } = await deploy(pub, actors, snapshot);
  console.log(`deployed: vault ${deployment.contracts.CoverVault}, adapter ${deployment.contracts.MockBackstopAdapter} (setup gas ${setupGas})`);
  const deploymentPath = join(work, `${spec.name}.deployment.json`);
  writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
  const keyPath = join(work, "keeper.env");
  writeFileSync(keyPath, `KEEPER_PK=${actors.keeperKey}\n`, { mode: 0o600 });

  const keeper = await startKeeper(url, deploymentPath, keyPath);
  console.log(`keeper ${keeperHd.address} watching (separate process)`);
  let run: ScenarioRun;
  try {
    run = await runScenario(
      { publicClient: pub, wallet: actors.runner, deployment, log: (m) => console.log(m) },
      spec,
      snapshot,
      { batching, pollMs: POLL_MS, settleTimeoutMs: 60_000 },
    );
    // The runner already waited for the chain. Wait for the keeper's own log to catch up too.
    const paidOut = run.after!.paidOut - run.before.paidOut;
    const logged = () => keeper.lines.filter((l) => l.type === "payout").reduce((s, l) => s + BigInt(l.paid as string), 0n);
    for (let i = 0; i < 100 && logged() < paidOut; i++) await sleep(POLL_MS);
  } finally {
    await keeper.stop();
  }

  const payouts = keeper.lines.filter((l) => l.type === "payout");
  for (const p of payouts) {
    console.log(
      `LayerPayout: shortfall ${formatUnits(BigInt(p.shortfall as string))}, paid ${formatUnits(BigInt(p.paid as string))}, ` +
        `remaining limit ${formatUnits(BigInt(p.remainingLimit as string))} (block ${p.block}, ${p.blocksAfterShortfall ?? "?"} blocks after the shortfall, trigger ${p.trigger})`,
    );
  }
  const keeperGas = { txs: payouts.length, gas: payouts.reduce((s, p) => s + BigInt(p.gasUsed as string), 0n) };
  const gas = gasSummary(run, keeperGas, setupGas);
  const cmp = compare(run);
  console.log(formatTable(run, cmp));

  const report = buildReport(run, cmp, {
    network: "anvil",
    chainId: 31337,
    anvil: version,
    snapshot: { path: relative(REPO_DIR, DEFAULT_SNAPSHOT), block: snapshot.block, takenAt: snapshot.takenAt },
    deployment,
    gas,
    keeper: { process: "separate (src/watcher.ts)", payouts, shortfallEvents: keeper.lines.filter((l) => l.type === "shortfall").length },
  });
  mkdirSync(REPORTS_DIR, { recursive: true });
  const out = join(REPORTS_DIR, `${spec.name}.json`);
  writeFileSync(out, `${JSON.stringify(report, bigintReplacer, 2)}\n`);
  console.log(`report: ${relative(REPO_DIR, out)}`);
  return {
    spec,
    run,
    pass: cmp.pass,
    maxDiff: Math.max(...cmp.rows.map((r) => Math.abs(r.diff))),
    tolerance: cmp.tolerance,
    gas,
    payouts: payouts.length,
  };
}

// ---------------------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const names: string[] = [];
  args.forEach((a, i) => {
    if (a === "--scenario" && args[i + 1]) names.push(...(args[i + 1] as string).split(","));
  });
  const specs = names.length ? names.map(findScenario) : SCENARIOS;
  const bi = args.indexOf("--batch");
  const batching = (bi >= 0 ? args[bi + 1] : "step") as Batching;

  artifact("CoverVault"); // build first if needed
  const snapshot = loadSnapshot();
  const work = mkdtempSync(join(tmpdir(), "spillway-e2e-"));
  const anvil = await startAnvil();
  console.log(`${anvil.version} on ${anvil.url}`);
  const outcomes: Outcome[] = [];
  try {
    for (const spec of specs) outcomes.push(await runOne(anvil.url, anvil.version, spec, snapshot, batching, work));
  } finally {
    anvil.stop();
  }

  console.log("\nsummary");
  const head = ["scenario", "band", "bad debt", "fund", "layer", "ADL", "max |diff|", "tolerance", "txs", "gas", "result"];
  const rows = outcomes.map((o) => {
    const a = o.run.after!;
    return [
      o.spec.name,
      String(o.run.engine.totals.band),
      formatUnits(a.badDebtTotal),
      formatUnits(a.fundPaid),
      formatUnits(a.layerPaid),
      formatUnits(a.adlLoss),
      o.maxDiff.toFixed(7),
      o.tolerance.toFixed(6),
      String(o.run.sent.length + o.payouts),
      o.gas.scenarioTotal.toString(),
      o.pass ? "PASS" : "FAIL",
    ];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i] as number) : c.padStart(widths[i] as number))).join("  ");
  console.log([line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n"));
  console.log("money in tUSD as booked on chain. gas = runner and keeper transactions of the scenario, setup excluded.");
  if (outcomes.some((o) => !o.pass)) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
