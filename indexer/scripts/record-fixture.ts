// Record one market's full log history and Morpho's storage for it at a block, as a test fixture, so
// the replay can be tested against the chain without the network.
//
//   tsx scripts/record-fixture.ts --market <id> --block <n> --out test/fixtures/<name>.json
//
// Logs come from the local store (run `fetch --block <n>` first); storage from eth_call at the block.

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import { indexerConfig } from "../src/config.js";
import { decode, type RawLog } from "../src/events.js";
import { logsUpTo, pickSource } from "../src/logs.js";
import { call } from "../src/rpc.js";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
const id = (arg("market") ?? "").toLowerCase();
const block = Number(arg("block"));
const out = resolve(arg("out") ?? join(here, "..", "test", "fixtures", `market-${id.slice(2, 10)}.json`));

const logs: RawLog[] = [];
const users = new Set<string>();
for await (const range of logsUpTo(block, join(here, "..", "cache"), pickSource("rpc")))
  for (const l of range.logs) {
    const e = decode(l);
    if (!e || !("id" in e) || e.id !== id || l.block > block) continue;
    logs.push(l);
    if ("onBehalf" in e) users.add(e.onBehalf);
    if ("borrower" in e) users.add(e.borrower);
  }

const abi = parseAbi([
  "function market(bytes32 id) view returns (uint128, uint128, uint128, uint128, uint128, uint128)",
  "function position(bytes32 id, address user) view returns (uint256, uint128, uint128)",
]);
async function read(functionName: "market" | "position", args: readonly unknown[]): Promise<string[]> {
  const r = await call(indexerConfig.morpho.address, encodeFunctionData({ abi, functionName, args } as never), block);
  if (!r) throw new Error(`${functionName} reverted`);
  return (decodeFunctionResult({ abi, functionName, data: r as Hex } as never) as unknown as bigint[]).map(String);
}

const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = await read("market", [id]);
const positions: Record<string, { supplyShares: string; borrowShares: string; collateral: string }> = {};
for (const u of [...users].sort()) {
  const [supplyShares, borrowShares, collateral] = (await read("position", [id, u])) as [string, string, string];
  positions[u] = { supplyShares, borrowShares, collateral };
}

const fixture = {
  about: `Every Morpho Blue log of market ${id} on Monad from deployment to block ${block}, and Morpho's storage for it at that block (eth_call).`,
  market: id,
  block,
  // Compact rows: [block, timestamp, logIndex, tx, topics joined by commas, data], as the log store keeps them.
  logs: logs.map((l) => [l.block, l.timestamp, l.logIndex, l.tx, l.topics.join(","), l.data]),
  storage: { market: { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee }, positions },
};
writeFileSync(out, `${JSON.stringify(fixture, null, 0)}\n`);
console.log(`${out}: ${logs.length} logs, ${users.size} users`);
