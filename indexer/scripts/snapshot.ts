// Rebuild every Morpho Blue market and position on Monad at one block from Morpho's own events, and
// write it as a `spillway.morpho-snapshot/1` file that lending/ loads like the API snapshot.
//
//   pnpm --filter @spillway/indexer run snapshot --block <n> --out <file>
//       [--labels fixtures/morpho/monad-2026-10-06.json] [--source hypersync|rpc] [--cache <dir>]
//
// Logs come from Envio HyperSync when ENVIO_API_TOKEN is set, else from the public RPC. --labels names
// a reference API snapshot for the fields that are not on chain (USD prices, listing, vault names).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawSnapshot } from "@spillway/lending";
import { readMetadata } from "../src/chain.js";
import { indexerConfig } from "../src/config.js";
import { pickSource } from "../src/logs.js";
import { blockAt } from "../src/rpc.js";
import { replayTo } from "../src/run.js";
import { buildSnapshot, type IndexedSnapshot } from "../src/snapshot.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const cwd = process.env.INIT_CWD ?? process.cwd();
const arg = (name: string) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);

const block = Number(arg("block"));
const outArg = arg("out");
if (!Number.isInteger(block) || block <= 0 || !outArg) throw new Error("usage: snapshot --block <n> --out <file> [--labels <api snapshot>] [--source hypersync|rpc]");
const out = resolve(cwd, outArg);
const labelsPath = arg("labels") ? resolve(cwd, arg("labels") as string) : null;
const labels = labelsPath ? (JSON.parse(readFileSync(labelsPath, "utf8")) as RawSnapshot) : null;
const cache = resolve(cwd, arg("cache") ?? join(here, "..", "cache"));
const source = pickSource(arg("source"));

let snapshot: IndexedSnapshot | null = null;
const stats = await replayTo(
  [block],
  cache,
  source,
  async (b, book) => {
    if (book.checks.failed.length > 0) console.error(`warning: ${book.checks.failed.length} events disagree with the replayed state; first at ${book.checks.failed[0]?.block}`);
    const at = await blockAt(b);
    const meta = await readMetadata(book, b);
    snapshot = buildSnapshot(book, at, meta, labels, {
      logs: source.kind,
      rpc: indexerConfig.rpc.url,
      morpho: indexerConfig.morpho.address,
      fromBlock: indexerConfig.morpho.deploymentBlock,
      labels: labelsPath ? relative(root, labelsPath) : null,
    });
  },
  (msg) => console.error(msg),
);
if (!snapshot) throw new Error("replay produced no snapshot");
const s = snapshot as IndexedSnapshot;

// As engine/scripts/snapshot-morpho.ts does: hash the body, then store the hash beside it.
const text = JSON.stringify(s);
const hash = createHash("sha256").update(text).digest("hex");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ ...s, sha256OfBody: hash })}\n`);
console.log(
  `${relative(cwd, out)}: block ${block}, ${s.counts.markets} markets, ${s.counts.positions} positions, ${stats.logs} logs (${source.kind}), ` +
    `${s.counts.checksPassed} checks passed, ${s.counts.checksFailed} failed, sha256 ${hash.slice(0, 16)}`,
);
