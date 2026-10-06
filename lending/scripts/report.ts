// Stress test every Morpho market in a snapshot and write the bundle.
//
//   pnpm --filter @spillway/lending run report <snapshot.json> --out <bundle.json> [--adapters <file>]
//
// The adapters file defaults to the snapshot's name with .adapters.json, when it exists. The bundle
// carries a manifest: the inputs' SHA-256, the Monad block range, the git commit and the config hash.
// The same inputs at the same commit give the same bytes.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, buildLendingBundle, configHash, loadBook } from "../src/index.js";
import type { AdaptersFile, RawSnapshot } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
// pnpm --filter runs the script inside lending/, so relative paths are read from where it was called.
const cwd = process.env.INIT_CWD ?? process.cwd();

const [snapshotArg, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const outArg = flag("out");
if (!snapshotArg || !outArg) {
  console.error("usage: report <snapshot.json> --out <bundle.json> [--adapters <file>]");
  process.exit(1);
}

const snapshotPath = resolve(cwd, snapshotArg);
const adaptersPath = flag("adapters") ? resolve(cwd, flag("adapters") as string) : snapshotPath.replace(/\.json$/, ".adapters.json");
const outPath = resolve(cwd, outArg);

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
// Paths in the manifest are relative to the repository, so the bundle does not depend on where it ran.
const repoPath = (p: string) => relative(root, p).split("\\").join("/");

const snapshotBytes = readFileSync(snapshotPath);
const adaptersBytes = existsSync(adaptersPath) ? readFileSync(adaptersPath) : null;
const book = loadBook(
  JSON.parse(snapshotBytes.toString("utf8")) as RawSnapshot,
  adaptersBytes ? (JSON.parse(adaptersBytes.toString("utf8")) as AdaptersFile) : undefined,
);
const cfg = DEFAULT_CONFIG;
const fixture = repoPath(snapshotPath);
const adapters = adaptersBytes ? repoPath(adaptersPath) : null;

const bundle = buildLendingBundle(book, cfg, {
  fixture: { path: fixture, sha256: sha256(snapshotBytes) },
  adapters: adapters && adaptersBytes ? { path: adapters, sha256: sha256(adaptersBytes) } : null,
  chainId: book.chainId,
  blocks: { from: book.blocks.from.number, to: book.blocks.to.number },
  takenAt: book.takenAt,
  commit: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain", "--", "lending", "fixtures/morpho") !== "",
  configSha256: configHash(cfg),
  // Run from the repository root.
  command: `pnpm --filter @spillway/lending run report ${fixture} --out lending-bundle.json${adapters && flag("adapters") ? ` --adapters ${adapters}` : ""}`,
});
writeFileSync(outPath, `${JSON.stringify(bundle)}\n`);

const s = bundle.summary;
const m = (x: number) => `$${(x / 1e6).toFixed(2)}M`;
const pct = (x: number | null) => (x === null ? "never" : `${Math.round(x * 100)}%`);
const at = (xs: { shock: number; lossUsd: number }[], shock: number) => xs.find((x) => x.shock === shock)?.lossUsd ?? 0;
console.error(`${outPath}: ${s.marketsWithBorrowers} markets with borrowers, ${s.borrowers} borrowers, ${m(s.debtUsd)} borrowed`);
console.error(`Headline: ${s.headlineScenario} (liquidators sell only what Monad's exits take), against "${s.comparisonScenario}".`);
console.error("The five largest markets: what would have to happen for suppliers to lose money");
console.table(
  bundle.headline.markets.map((r) => ({
    market: r.pair,
    shock: r.shockMeans ?? "oracle not read",
    debt: m(r.debtUsd),
    exitDepth: r.exit.depthUsd === null ? "not measured" : `$${Math.round(r.exit.depthUsd).toLocaleString("en-US")}`,
    firstLoss: pct(r.firstLoss),
    "25% thin": m(at(r.lossUsd, 0.25)),
    "25% always act": m(at(r.alwaysActUsd, 0.25)),
  })),
);
console.error("Collateral tokens by probable maximum loss");
console.table(
  bundle.headline.pml.map((r) => ({ token: r.symbol, class: r.class, markets: r.markets, pml: m(r.pmlUsd), firstLoss: pct(r.firstLoss), "25% thin": m(at(r.lossUsd, 0.25)), "25% always act": m(at(r.alwaysActUsd, 0.25)) })),
);
console.error("Cover for the five largest vaults, limit at each class's 90th percentile fall");
console.table(
  bundle.headline.pricing.map((p) => ({
    vault: p.name ?? p.vault,
    supply: m(p.supplyUsd),
    limit: m(p.limitUsd),
    worst: p.limitToken,
    expectedLoss: m(p.expectedLossUsd),
    rate: `${(p.rate * 100).toFixed(1)}%`,
    rateHigh: `${(p.rateHigh * 100).toFixed(1)}%`,
    placeholder: p.placeholderTokens.join(" ") || "none",
  })),
);
