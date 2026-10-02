// Build the data the web app loads: a snapshot and the engine's bundle for it.
//   tsx scripts/build-data.ts [snapshot.json]
// Defaults to the committed mainnet BTC fixture.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DailyHistory, type PriceSeries, type Snapshot, buildBundle, withConfig } from "@spillway/engine";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const input = resolve(process.argv[2] ?? join(root, "fixtures", "snapshots", "btc-mainnet.json"));
if (!existsSync(input)) throw new Error(`no snapshot at ${input}`);

const snapshot = JSON.parse(readFileSync(input, "utf8")) as Snapshot;
const history = JSON.parse(readFileSync(join(root, "engine", "data", "btc-usd-daily.json"), "utf8")) as DailyHistory;
const crash = JSON.parse(readFileSync(join(root, "engine", "data", "replay-2025-10-10.json"), "utf8")) as PriceSeries;

const out = join(here, "..", "public", "data");
mkdirSync(out, { recursive: true });
const bundle = buildBundle(snapshot, withConfig(), history, crash);
writeFileSync(join(out, "snapshot.json"), JSON.stringify(snapshot));
writeFileSync(join(out, "bundle.json"), JSON.stringify(bundle));
console.log(`wrote ${out} from ${input}`);
console.table(bundle.summary);
