// Chains, clients, keys, deployment files and one consistent read of the contracts' state.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry, monadTestnet } from "viem/chains";
import { adapterAbi, vaultAbi } from "./abi.js";

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = resolve(PACKAGE_DIR, "..");
export const MONAD_TESTNET_RPC = "https://testnet-rpc.monad.xyz";
export const MONAD_TESTNET_ID = 10143;

// ------------------------------------------------------------------ deployments

/** What the runner and watcher need to find the contracts. Shape of deployments/*.json. */
export interface Deployment {
  schema: "spillway.deployment/1";
  network: string;
  chainId: number;
  /** Optional. RPC_URL or --rpc wins over it. */
  rpcUrl?: string;
  /** Block of the first deploy transaction. The watcher never needs to look earlier. */
  deployBlock: number;
  contracts: {
    MockUSD: Address;
    MockBackstopAdapter: Address;
    CoverVault: Address;
  };
  /** For people reading the file. The scripts read roles from the contracts. */
  roles?: { owner?: Address; runner?: Address; sponsor?: Address };
}

export function loadDeployment(path: string): Deployment {
  const d = JSON.parse(readFileSync(path, "utf8")) as Deployment;
  if (d.schema !== "spillway.deployment/1") throw new Error(`${path}: not a spillway.deployment/1 file`);
  for (const k of ["MockUSD", "MockBackstopAdapter", "CoverVault"] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(d.contracts?.[k] ?? "")) throw new Error(`${path}: contracts.${k} is not an address`);
  }
  if (!Number.isInteger(d.chainId)) throw new Error(`${path}: chainId missing`);
  return d;
}

// ------------------------------------------------------------------------- keys

const KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/** "~/x" to an absolute path. */
export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/**
 * Reads a private key from the file named by the environment variable `fileVar`. The file holds
 * KEY=VALUE lines (`export` and quotes allowed), and the first of `names` found is used. The key
 * never appears in an error message or a log.
 */
export function loadKey(fileVar: string, names: string[]): Hex {
  const path = process.env[fileVar];
  if (!path) throw new Error(`set ${fileVar} to the path of a file holding ${names.join(" or ")}=0x...`);
  let text: string;
  try {
    text = readFileSync(expandHome(path), "utf8");
  } catch {
    throw new Error(`${fileVar}: cannot read ${path}`);
  }
  const vars = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    vars.set(m[1] as string, (m[2] as string).replace(/^["']|["']$/g, "").trim());
  }
  for (const name of names) {
    const v = vars.get(name);
    if (v === undefined) continue;
    if (!KEY_RE.test(v)) throw new Error(`${fileVar}: ${name} in ${path} is not a 32-byte hex key`);
    return (v.startsWith("0x") ? v : `0x${v}`) as Hex;
  }
  throw new Error(`${fileVar}: ${path} has none of ${names.join(", ")}`);
}

export function accountFromKey(key: Hex): Account {
  return privateKeyToAccount(key);
}

// ----------------------------------------------------------------------- clients

export function chainFor(chainId: number, rpcUrl: string): Chain {
  const rpcUrls = { default: { http: [rpcUrl] } };
  if (chainId === MONAD_TESTNET_ID) return { ...monadTestnet, rpcUrls };
  if (chainId === foundry.id) return { ...foundry, rpcUrls };
  return defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls });
}

export type Public = PublicClient<Transport, Chain>;
export type Wallet = WalletClient<Transport, Chain, Account>;

// A loaded machine can take a while to answer, even on anvil. viem's default is 10 seconds.
const transportFor = (chain: Chain) => http(chain.rpcUrls.default.http[0], { timeout: 60_000 });

export function publicClientFor(chain: Chain, pollingInterval: number): Public {
  return createPublicClient({ chain, transport: transportFor(chain), pollingInterval }) as Public;
}

export function walletClientFor(chain: Chain, account: Account, pollingInterval: number): Wallet {
  return createWalletClient({ chain, account, transport: transportFor(chain), pollingInterval });
}

/** Loads watcher/.env when it exists. It should hold paths and URLs, never keys. */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile(join(PACKAGE_DIR, ".env"));
  } catch {
    // no .env: fine
  }
}

// ------------------------------------------------------------------------- state

/** Everything the comparison needs, read at one block. Money in base units. */
export interface ChainState {
  block: bigint;
  insuranceFund: bigint;
  pendingShortfall: bigint;
  badDebtTotal: bigint;
  fundPaid: bigint;
  layerPaid: bigint;
  adlLoss: bigint;
  limit: bigint;
  paidOut: bigint;
  remainingLimit: bigint;
  totalPrincipal: bigint;
  coverActive: boolean;
}

export async function readState(client: Public, d: Deployment, block?: bigint): Promise<ChainState> {
  // cacheTime 0: viem caches the block number for one polling interval, and a state read at a
  // stale block misses the last transactions. The e2e caught this as a wrong "after" state.
  const blockNumber = block ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const a = { address: d.contracts.MockBackstopAdapter, abi: adapterAbi, blockNumber } as const;
  const v = { address: d.contracts.CoverVault, abi: vaultAbi, blockNumber } as const;
  const [insuranceFund, pendingShortfall, badDebtTotal, fundPaid, layerPaid, adlLoss, limit, paidOut, remainingLimit, totalPrincipal, coverActive] =
    await Promise.all([
      client.readContract({ ...a, functionName: "insuranceFund" }),
      client.readContract({ ...a, functionName: "pendingShortfall" }),
      client.readContract({ ...a, functionName: "badDebtTotal" }),
      client.readContract({ ...a, functionName: "fundPaid" }),
      client.readContract({ ...a, functionName: "layerPaid" }),
      client.readContract({ ...a, functionName: "adlLoss" }),
      client.readContract({ ...v, functionName: "limit" }),
      client.readContract({ ...v, functionName: "paidOut" }),
      client.readContract({ ...v, functionName: "remainingLimit" }),
      client.readContract({ ...v, functionName: "totalPrincipal" }),
      client.readContract({ ...v, functionName: "isCoverActive" }),
    ]);
  return { block: blockNumber, insuranceFund, pendingShortfall, badDebtTotal, fundPaid, layerPaid, adlLoss, limit, paidOut, remainingLimit, totalPrincipal, coverActive };
}

/** The most the vault can still pay: min(remaining limit, principal), or 0 outside the term. */
export function layerCapacity(s: ChainState): bigint {
  if (!s.coverActive) return 0n;
  return s.remainingLimit < s.totalPrincipal ? s.remainingLimit : s.totalPrincipal;
}

/** JSON.stringify replacer that writes bigints as decimal strings. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TRANSIENT = /took too long|timed out|HTTP request failed|fetch failed|ECONNRESET|socket hang up/i;

/**
 * Signs locally, sends, and waits for the receipt. The hash is known before the send, so a
 * send that times out (the node may have taken the transaction and answered late) is checked
 * by hash and retried with the same signed bytes, never with a new nonce. Throws on a revert.
 */
export async function sendTx(
  pub: Public,
  wallet: Wallet,
  req: { to?: Address; data: Hex; gas?: bigint },
  label: string,
  pollMs: number,
): Promise<TransactionReceipt> {
  const prepared = await wallet.prepareTransactionRequest({ account: wallet.account, chain: wallet.chain, to: req.to, data: req.data, gas: req.gas });
  const raw = await wallet.signTransaction(prepared);
  const hash = keccak256(raw);
  for (let attempt = 1; ; attempt++) {
    try {
      await pub.sendRawTransaction({ serializedTransaction: raw });
      break;
    } catch (e) {
      const known = await pub.getTransaction({ hash }).then(
        () => true,
        () => false,
      );
      if (known) break;
      if (attempt >= 4 || !TRANSIENT.test(String((e as Error)?.message))) throw e;
      await sleep(1000 * attempt);
    }
  }
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: pollMs, retryCount: 10 });
  if (r.status !== "success") throw new Error(`${label} reverted in ${hash} (gas used ${r.gasUsed} of limit ${prepared.gas})`);
  return r;
}
