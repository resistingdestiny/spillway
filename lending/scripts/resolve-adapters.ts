// Find which Morpho vault each supplier in a snapshot supplies for, read on chain.
//
//   tsx scripts/resolve-adapters.ts <snapshot.json> [--out <snapshot>.adapters.json]
//
// A Morpho Vault V2 does not supply Morpho Blue itself. It supplies through an adapter contract
// (MorphoMarketV1Adapter), so the supplier on a market is the adapter's address and never matches the
// vault addresses in the API's `supplyingVaultV2s`. Every adapter exposes `parentVault()`. We call it
// on every supplier address at the snapshot's closing block: an adapter answers with its vault, a
// wallet or any other contract answers with nothing. The result is committed next to the snapshot so
// the report itself never touches the network.

import { readFileSync, writeFileSync } from "node:fs";
import type { RawSnapshot } from "../src/snapshot.js";

const RPC = "https://rpc.monad.xyz";
// First four bytes of keccak256("parentVault()") and keccak256("name()").
const PARENT_VAULT = "0x0fe36536";
const NAME = "0x06fdde03";
// The public RPC allows 15 requests a second. Batches of 10, one a second, stay under it.
const BATCH = 10;

const [snapshotPath, ...rest] = process.argv.slice(2);
if (!snapshotPath) {
  console.error("usage: resolve-adapters.ts <snapshot.json> [--out <file>]");
  process.exit(1);
}
const outPath = rest.includes("--out") ? (rest[rest.indexOf("--out") + 1] as string) : snapshotPath.replace(/\.json$/, ".adapters.json");
const snap = JSON.parse(readFileSync(snapshotPath, "utf8")) as RawSnapshot;
const block = snap.blockAfter.number;
const tag = `0x${block.toString(16)}`;

async function calls(to: string[], data: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < to.length; i += BATCH) {
    const chunk = to.slice(i, i + BATCH);
    const body = chunk.map((a, j) => ({ jsonrpc: "2.0", id: j, method: "eth_call", params: [{ to: a, data }, tag] }));
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json()) as { id: number; result?: string; error?: { message: string } }[];
      // A revert is an answer (not an adapter). Anything else, such as a rate limit, is retried.
      const retry = !Array.isArray(json) || json.some((r) => r.error && !/revert/i.test(r.error.message));
      if (!retry) {
        const byId = new Map(json.map((r) => [r.id, r.result ?? "0x"]));
        out.push(...chunk.map((_, j) => byId.get(j) ?? "0x"));
        break;
      }
      if (attempt >= 4) throw new Error(`RPC failed for ${chunk[0]}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return out;
}

const address = (word: string): string | null => {
  if (word.length !== 66) return null;
  const a = `0x${word.slice(26)}`.toLowerCase();
  return /^0x0{40}$/.test(a) ? null : a;
};

const text = (ret: string): string => {
  // ABI string: offset, length, bytes.
  if (ret.length < 2 + 128) return "";
  const len = Number.parseInt(ret.slice(2 + 64, 2 + 128), 16);
  return Buffer.from(ret.slice(2 + 128, 2 + 128 + len * 2), "hex").toString("utf8");
};

const suppliers = [
  ...new Set(snap.positions.filter((p) => String(p.state.supplyShares ?? 0) !== "0").map((p) => p.user.address.toLowerCase())),
].sort();
const parents = await calls(suppliers, PARENT_VAULT);
const adapters: Record<string, string> = {};
suppliers.forEach((s, i) => {
  const v = address(parents[i] as string);
  if (v) adapters[s] = v;
});
const vaults = [...new Set(Object.values(adapters))].sort();
const names: Record<string, string> = {};
(await calls(vaults, NAME)).forEach((r, i) => {
  names[vaults[i] as string] = text(r).trim();
});

const file = {
  schema: "spillway.morpho-adapters/1",
  chainId: snap.chainId,
  rpc: RPC,
  block,
  method: "parentVault()",
  suppliersChecked: suppliers.length,
  adapters,
  names,
};
writeFileSync(outPath, `${JSON.stringify(file, null, 1)}\n`);
console.log(`${outPath}: ${Object.keys(adapters).length} of ${suppliers.length} suppliers are adapters of ${vaults.length} vaults, at block ${block}`);
