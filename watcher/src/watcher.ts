// Keeper: watches the adapter for Shortfall and calls vault.settle() right away.
//
// It runs apart from the runner, as a keeper bot (or later a Chainlink CRE workflow) would.
// Two triggers lead to the same settle path:
//   - a Shortfall event on the adapter (viem log watcher)
//   - a poll of adapter.pendingShortfall(), in case an event is missed or the watcher starts late
// One settle runs at a time. A trigger that lands while a settle is in flight queues one more
// pass, which reads the shortfall again. settle() is permissionless, so the keeper only needs gas.
//
// As a command it prints one JSON line per thing it sees or does (ready, shortfall, payout,
// exhausted, error):
//
//   KEEPER_KEY_FILE=~/.secrets/spillway-keeper.env \
//   pnpm --filter @spillway/watcher watcher [--deployment <file>] [--rpc <url>] [--poll-ms 1000]

import { pathToFileURL } from "node:url";
import { type Address, encodeFunctionData, parseEventLogs } from "viem";
import { adapterAbi, vaultAbi } from "./abi.js";
import {
  MONAD_TESTNET_RPC,
  PACKAGE_DIR,
  type Public,
  type Wallet,
  accountFromKey,
  bigintReplacer,
  chainFor,
  loadDeployment,
  loadDotEnv,
  loadKey,
  publicClientFor,
  sendTx,
  walletClientFor,
} from "./chain.js";

export type WatcherLog =
  | { type: "ready"; keeper: Address; adapter: Address; vault: Address; chainId: number; block: bigint }
  | { type: "shortfall"; amount: bigint; pendingShortfall: bigint; block: bigint; tx: string }
  | {
      type: "payout";
      shortfall: bigint;
      paid: bigint;
      remainingLimit: bigint;
      tx: string;
      block: bigint;
      gasUsed: bigint;
      trigger: "event" | "poll";
      /** Blocks from the first Shortfall not yet paid to this payout. */
      blocksAfterShortfall?: number;
    }
  | { type: "exhausted"; pendingShortfall: bigint; block: bigint }
  | { type: "error"; message: string };

export interface WatcherOptions {
  publicClient: Public;
  wallet: Wallet;
  adapter: Address;
  vault: Address;
  /** How often the log watcher polls for new events. */
  pollMs: number;
  /** How often to read pendingShortfall() as a fallback. */
  fallbackMs?: number;
  log: (entry: WatcherLog) => void;
}

export interface WatcherHandle {
  stop: () => Promise<void>;
}

export async function startWatcher(o: WatcherOptions): Promise<WatcherHandle> {
  const { publicClient, wallet, adapter, vault } = o;
  // The same error on every poll (an RPC that is down) is logged once until something changes.
  let lastError = "";
  const log = (entry: WatcherLog) => {
    if (entry.type === "error") {
      if (entry.message === lastError) return;
      lastError = entry.message;
    } else lastError = "";
    o.log(entry);
  };
  let busy: Promise<void> | null = null;
  let queued: "event" | "poll" | null = null;
  let stopped = false;
  let exhaustedLogged = false;
  // Shortfalls after this block are not paid yet. Used to measure how fast payouts land.
  let lastPayoutBlock = await publicClient.getBlockNumber({ cacheTime: 0 });

  const trySettle = async (trigger: "event" | "poll") => {
    const pending = await publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "pendingShortfall" });
    if (pending === 0n) return;
    const [remaining, principal, active] = await Promise.all([
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "remainingLimit" }),
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalPrincipal" }),
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "isCoverActive" }),
    ]);
    if (!active || remaining === 0n || principal === 0n) {
      // Nothing the layer can pay. The runner books the rest as ADL.
      if (!exhaustedLogged) log({ type: "exhausted", pendingShortfall: pending, block: await publicClient.getBlockNumber({ cacheTime: 0 }) });
      exhaustedLogged = true;
      return;
    }
    const r = await sendTx(publicClient, wallet, { to: vault, data: encodeFunctionData({ abi: vaultAbi, functionName: "settle" }) }, "settle", o.pollMs);
    const hash = r.transactionHash;
    let firstShortfall: bigint | undefined;
    try {
      const evs = await publicClient.getContractEvents({
        address: adapter,
        abi: adapterAbi,
        eventName: "Shortfall",
        fromBlock: lastPayoutBlock + 1n,
        toBlock: r.blockNumber,
      });
      firstShortfall = evs[0]?.blockNumber ?? undefined;
    } catch {
      // Latency is for the log only. Some RPCs limit getLogs ranges.
    }
    lastPayoutBlock = r.blockNumber;
    for (const ev of parseEventLogs({ abi: vaultAbi, logs: r.logs, eventName: "LayerPayout" })) {
      log({
        type: "payout",
        shortfall: ev.args.shortfall,
        paid: ev.args.paid,
        remainingLimit: ev.args.remainingLimit,
        tx: hash,
        block: r.blockNumber,
        gasUsed: r.gasUsed,
        trigger,
        blocksAfterShortfall: firstShortfall === undefined ? undefined : Number(r.blockNumber - firstShortfall),
      });
    }
  };

  const kick = (trigger: "event" | "poll") => {
    if (stopped) return;
    if (busy) {
      queued ??= trigger;
      return;
    }
    busy = (async () => {
      let next: "event" | "poll" | null = trigger;
      while (next && !stopped) {
        queued = null;
        try {
          await trySettle(next);
        } catch (e) {
          log({ type: "error", message: e instanceof Error ? e.message.split("\n")[0] ?? "" : String(e) });
        }
        next = queued;
      }
      busy = null;
    })();
  };

  const unwatch = publicClient.watchContractEvent({
    address: adapter,
    abi: adapterAbi,
    eventName: "Shortfall",
    poll: true,
    pollingInterval: o.pollMs,
    onLogs: (logs) => {
      for (const l of logs) {
        log({
          type: "shortfall",
          amount: l.args.amount ?? 0n,
          pendingShortfall: l.args.pendingShortfall ?? 0n,
          block: l.blockNumber ?? 0n,
          tx: l.transactionHash ?? "",
        });
      }
      kick("event");
    },
    onError: (e) => log({ type: "error", message: e.message.split("\n")[0] ?? "" }),
  });
  const timer = setInterval(() => kick("poll"), o.fallbackMs ?? o.pollMs * 4);

  log({
    type: "ready",
    keeper: wallet.account.address,
    adapter,
    vault,
    chainId: await publicClient.getChainId(),
    block: await publicClient.getBlockNumber({ cacheTime: 0 }),
  });
  kick("poll"); // a shortfall left from before the watcher started

  return {
    stop: async () => {
      stopped = true;
      unwatch();
      clearInterval(timer);
      if (busy) await busy;
    },
  };
}

// --------------------------------------------------------------------------- CLI

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  loadDotEnv();
  const args = process.argv.slice(2);
  const d = loadDeployment(arg(args, "deployment") ?? process.env.DEPLOYMENT ?? `${PACKAGE_DIR}/deployments/monad-testnet.json`);
  const rpc = arg(args, "rpc") ?? process.env.RPC_URL ?? d.rpcUrl ?? MONAD_TESTNET_RPC;
  const pollMs = Number(arg(args, "poll-ms") ?? (d.chainId === 31337 ? 100 : 1000));
  const chain = chainFor(d.chainId, rpc);
  const publicClient = publicClientFor(chain, pollMs);
  const chainId = await publicClient.getChainId();
  if (chainId !== d.chainId) throw new Error(`${rpc} is chain ${chainId}, the deployment says ${d.chainId}`);
  const wallet = walletClientFor(chain, accountFromKey(loadKey("KEEPER_KEY_FILE", ["KEEPER_PK", "DEPLOYER_PK"])), pollMs);

  const print = (entry: WatcherLog) => process.stdout.write(`${JSON.stringify(entry, bigintReplacer)}\n`);
  const handle = await startWatcher({
    publicClient,
    wallet,
    adapter: d.contracts.MockBackstopAdapter,
    vault: d.contracts.CoverVault,
    pollMs,
    log: print,
  });
  // A settle already sent is mined whether or not we wait for it, so do not hang on a dead RPC.
  const shutdown = () => {
    void Promise.race([handle.stop(), new Promise((r) => setTimeout(r, 3000))]).then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
