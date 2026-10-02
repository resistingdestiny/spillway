// Writes a deployments/*.json file from a forge broadcast file, so the runner and the watcher
// can find the contracts after `forge script script/Deploy.s.sol --broadcast`.
//
//   pnpm --filter @spillway/watcher deployment ../contracts/broadcast/Deploy.s.sol/10143/run-latest.json \
//     [--out deployments/monad-testnet.json]

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Address, getAddress } from "viem";
import { type Deployment, MONAD_TESTNET_ID, MONAD_TESTNET_RPC, PACKAGE_DIR } from "../src/chain.js";

interface Broadcast {
  chain: number;
  transactions: { transactionType: string; contractName: string | null; contractAddress: string | null; hash: string; transaction: { from: string } }[];
  receipts: { transactionHash: string; blockNumber: string }[];
}

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("usage: deployment-from-broadcast.ts <run-latest.json> [--out <file>]");
  process.exit(1);
}
const b = JSON.parse(readFileSync(file, "utf8")) as Broadcast;
const created = (name: string): { address: Address; block: number } => {
  const tx = b.transactions.find((t) => t.transactionType === "CREATE" && t.contractName === name);
  if (!tx?.contractAddress) throw new Error(`${file}: no CREATE for ${name}`);
  const receipt = b.receipts.find((r) => r.transactionHash === tx.hash);
  if (!receipt) throw new Error(`${file}: no receipt for ${name}; was it broadcast?`);
  return { address: getAddress(tx.contractAddress), block: Number(BigInt(receipt.blockNumber)) };
};
const usd = created("MockUSD");
const adapter = created("MockBackstopAdapter");
const vault = created("CoverVault");
const network = b.chain === MONAD_TESTNET_ID ? "monad-testnet" : `chain-${b.chain}`;

const d: Deployment = {
  schema: "spillway.deployment/1",
  network,
  chainId: b.chain,
  ...(b.chain === MONAD_TESTNET_ID ? { rpcUrl: MONAD_TESTNET_RPC } : {}),
  deployBlock: Math.min(usd.block, adapter.block, vault.block),
  contracts: { MockUSD: usd.address, MockBackstopAdapter: adapter.address, CoverVault: vault.address },
  roles: { owner: getAddress(b.transactions[0]?.transaction.from ?? "0x0000000000000000000000000000000000000000") },
};
const i = rest.indexOf("--out");
const out = i >= 0 && rest[i + 1] ? resolve(rest[i + 1] as string) : resolve(PACKAGE_DIR, "deployments", `${network}.json`);
writeFileSync(out, `${JSON.stringify(d, null, 2)}\n`);
console.error(`wrote ${out}`);
