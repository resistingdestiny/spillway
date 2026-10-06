// Fetch and store Morpho Blue's logs up to a block, replay them, and print what the replay found.
//
//   pnpm --filter @spillway/indexer run fetch --block <n> [--source hypersync|rpc] [--cache <dir>]

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pickSource } from "../src/logs.js";
import { replayTo } from "../src/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);

const block = Number(arg("block"));
if (!Number.isInteger(block) || block <= 0) throw new Error("--block <n> is required");
const cache = resolve(arg("cache") ?? join(here, "..", "cache"));
const source = pickSource(arg("source"));

const stats = await replayTo([block], cache, source, (b, book) => {
  let positions = 0;
  for (const byUser of book.positions.values()) for (const p of byUser.values()) if (p.supplyShares || p.borrowShares || p.collateral) positions++;
  const failed = book.checks.failed;
  console.log(`block ${b}: ${book.events} events, ${book.markets.size} markets, ${positions} open positions`);
  console.log(`checks: ${book.checks.passed} passed, ${failed.length} failed`);
  for (const f of failed.slice(0, 20)) console.log(`  ${f.kind} ${f.what} at ${f.block}:${f.logIndex} ${f.tx}: event ${f.event}, replayed ${f.replayed}`);
}, (msg) => console.error(msg));
console.log(`${stats.logs} logs from ${JSON.stringify(stats.sources)} ranges`);
