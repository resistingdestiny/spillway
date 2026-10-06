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
  interest: { zeroGap: number; gaps: number; toTheWei: number; within1e4: number; maxAbsResidual: number };
}

const ends: End[] = [];
const stats = await replayTo(
  [api.blockBefore.number, api.blockAfter.number],
  cache,
  source,
  async (block, book) => {
    const rec = reconcile(block, book, api, await borrowRates(book, block));
    const storage = await checkStorage(book, block);
    // Where the API's assets differ from storage, the gap should be the IRM's interest since lastUpdate.
    const gaps = rec.markets.rows.filter((r) => r.borrowAssetsGap !== "0");
    const off = (r: (typeof gaps)[number]) => (r.expectedInterest === null ? null : BigInt(r.borrowAssetsGap) - BigInt(r.expectedInterest));
    const toTheWei = gaps.filter((r) => {
      const d = off(r);
      return d !== null && d >= -1n && d <= 1n;
    });
    const rest = gaps.filter((r) => !toTheWei.includes(r));
    const interest = {
      zeroGap: rec.markets.rows.length - gaps.length,
      gaps: gaps.length,
      toTheWei: toTheWei.length,
      within1e4: rest.filter((r) => r.residual !== null && Math.abs(r.residual) < 1e-4).length,
      maxAbsResidual: Math.max(0, ...rest.map((r) => Math.abs(r.residual ?? 1))),
    };
    ends.push({ ...rec, storage, replay: { events: book.events, checksPassed: book.checks.passed, checksFailed: book.checks.failed.length }, interest });
    console.log(
      `block ${block}: storage ${storage.markets} markets and ${storage.positions} positions, ${storage.diffs.length} differences ` +
        `(${storage.diffs.filter((d) => !d.cause).length} unexplained); ` +
        `API positions ${rec.positions.exact}/${rec.positions.compared} exact, ${rec.positions.diffs.length} differences; ` +
        `API markets ${rec.markets.exact}/${rec.markets.compared} exact in shares and collateral; ` +
        `assets: ${interest.zeroGap} markets equal, ${interest.gaps} off by the IRM's interest since lastUpdate, ` +
        `${interest.toTheWei} of them to the wei, ${interest.within1e4} more within 0.01%, worst of the rest ${interest.maxAbsResidual.toExponential(2)}`,
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
