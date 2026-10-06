// Reconcile the book rebuilt from chain events with a Morpho API snapshot, at both ends of the block
// window the API state lies in, and check the rebuilt book against Morpho's own storage there.
//
//   pnpm --filter @spillway/indexer run reconcile [fixtures/morpho/monad-2026-10-06.json]
//       [--out indexer/reconciliation/monad-2026-10-06.json] [--source hypersync|rpc] [--cache <dir>]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawSnapshot } from "@spillway/lending";
import { borrowRates, checkStorage, type StorageDiff } from "../src/chain.js";
import { pickSource } from "../src/logs.js";
import { reconcile, type Reconciliation } from "../src/reconcile.js";
import { replayTo } from "../src/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const cwd = process.env.INIT_CWD ?? process.cwd();
const arg = (name: string) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
const positional = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && !(all[i - 1] ?? "").startsWith("--"));

const apiPath = resolve(cwd, positional ?? join(root, "fixtures", "morpho", "monad-2026-10-06.json"));
const api = JSON.parse(readFileSync(apiPath, "utf8")) as RawSnapshot;
const out = resolve(cwd, arg("out") ?? join(here, "..", "reconciliation", basename(apiPath)));
const cache = resolve(cwd, arg("cache") ?? join(here, "..", "cache"));
const source = pickSource(arg("source"));

interface End extends Reconciliation {
  storage: { markets: number; positions: number; diffs: StorageDiff[] };
  replay: { events: number; checksPassed: number; checksFailed: number };
  interest: { markets: number; zeroGap: number; maxAbsResidual: number; within1e4: number };
}

const ends: End[] = [];
const stats = await replayTo(
  [api.blockBefore.number, api.blockAfter.number],
  cache,
  source,
  async (block, book) => {
    const rec = reconcile(block, book, api, await borrowRates(book, block));
    const storage = await checkStorage(book, block);
    // Markets that carry debt, where the API's asset gap should be interest.
    const priced = rec.markets.rows.filter((r) => r.residual !== null && BigInt(r.borrowAssetsGap) > 1000n);
    const interest = {
      markets: priced.length,
      zeroGap: rec.markets.rows.filter((r) => r.borrowAssetsGap === "0").length,
      maxAbsResidual: Math.max(0, ...priced.map((r) => Math.abs(r.residual as number))),
      within1e4: priced.filter((r) => Math.abs(r.residual as number) < 1e-4).length,
    };
    ends.push({ ...rec, storage, replay: { events: book.events, checksPassed: book.checks.passed, checksFailed: book.checks.failed.length }, interest });
    console.log(
      `block ${block}: storage ${storage.markets} markets and ${storage.positions} positions, ${storage.diffs.length} differences ` +
        `(${storage.diffs.filter((d) => !d.cause).length} unexplained); ` +
        `API positions ${rec.positions.exact}/${rec.positions.compared} exact, ${rec.positions.diffs.length} differences; ` +
        `API markets ${rec.markets.exact}/${rec.markets.compared} exact in shares and collateral; ` +
        `asset gaps: ${interest.zeroGap} none, ${interest.markets} priced, ${interest.within1e4} within 0.01% of the IRM's interest, worst ${interest.maxAbsResidual.toExponential(2)}`,
    );
  },
  (msg) => console.error(msg),
);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify(
    { schema: "spillway.morpho-reconciliation/1", api: relative(root, apiPath), apiSha256: (api as { sha256OfBody?: string }).sha256OfBody ?? null, logs: stats, ends },
    null,
    1,
  )}\n`,
);
console.log(`${relative(cwd, out)}: ${stats.logs} logs replayed`);
