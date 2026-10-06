// Build the data the web app loads: a snapshot and the engine's bundle for it.
//   tsx scripts/build-data.ts [snapshot.json]
// Defaults to the committed mainnet BTC fixture.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type WorstHourHistory, type PriceSeries, type Snapshot, type WorstMinuteHistory, buildBundle, withConfig } from "@spillway/engine";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const input = resolve(process.argv[2] ?? join(root, "fixtures", "snapshots", "btc-mainnet.json"));
if (!existsSync(input)) throw new Error(`no snapshot at ${input}`);

const snapshot = JSON.parse(readFileSync(input, "utf8")) as Snapshot;
const history = JSON.parse(readFileSync(join(root, "engine", "data", "btc-usd-worst-hour.json"), "utf8")) as WorstHourHistory;
const crash = JSON.parse(readFileSync(join(root, "engine", "data", "replay-2025-10-10.json"), "utf8")) as PriceSeries;
const minutesFile = join(root, "engine", "data", "btc-usd-worst-minute.json");
const minutes = existsSync(minutesFile) ? (JSON.parse(readFileSync(minutesFile, "utf8")) as WorstMinuteHistory) : undefined;

const out = join(here, "..", "public", "data");
mkdirSync(out, { recursive: true });
const bundle = buildBundle(snapshot, withConfig(), history, crash, minutes);
writeFileSync(join(out, "snapshot.json"), JSON.stringify(snapshot));
writeFileSync(join(out, "bundle.json"), JSON.stringify(bundle));
// The lending snapshot and its vault map, served as published so the browser can rerun the engine.
const lendingOut = join(out, "lending");
mkdirSync(lendingOut, { recursive: true });
for (const f of ["monad-2026-10-06.json", "monad-2026-10-06.adapters.json"]) {
  writeFileSync(join(lendingOut, f), readFileSync(join(root, "fixtures", "morpho", f)));
}
// The lending bundle (cover prices, oracle kinds, exit depths), from the lending CLI so it matches what
// anyone gets by rerunning it.
execFileSync(
  "npx",
  ["tsx", join(root, "lending", "scripts", "report.ts"), join(root, "fixtures", "morpho", "monad-2026-10-06.json"), "--out", join(lendingOut, "bundle.json")],
  { stdio: "ignore", env: { ...process.env, INIT_CWD: root } },
);
console.log(`wrote ${out} from ${input}`);
console.table(bundle.summary);
