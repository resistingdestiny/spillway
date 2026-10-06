// A local store of Morpho Blue's logs, in fixed block ranges, so a replay to a new block fetches only
// what it has not seen. Each range is one gzipped JSON-lines file: a header naming the source and the
// range, then one log per line. History up to a block never changes on a finalized chain, so a stored
// range is reused as it is.
//
// Logs are read one range at a time, so the replay never holds the whole history in memory.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { indexerConfig } from "./config.js";
import { byChainOrder, type RawLog } from "./events.js";
import { fetchLogsHypersync } from "./hypersync.js";
import { fetchLogsRpc } from "./rpc.js";

export type Source = { kind: "hypersync"; token: string } | { kind: "rpc" };

/** Blocks per stored range. About 50,000 logs at 2026 rates. */
const RANGE = 5_000_000;

interface Header {
  schema: "spillway.morpho-logs/1";
  chainId: number;
  address: string;
  source: Source["kind"];
  from: number;
  to: number;
  count: number;
}

/** The ranges from Morpho's deployment to `to`, aligned so that all but the last are reusable. */
export function ranges(to: number): [number, number][] {
  const start = indexerConfig.morpho.deploymentBlock;
  const out: [number, number][] = [];
  for (let from = start; from <= to; from += RANGE) out.push([from, Math.min(to, from + RANGE - 1)]);
  return out;
}

const fileOf = (dir: string, [from, to]: [number, number]) => join(dir, `morpho-${from}-${to}.jsonl.gz`);

export function writeRange(file: string, header: Header, logs: RawLog[]) {
  const lines = [JSON.stringify(header), ...logs.map((l) => JSON.stringify([l.block, l.timestamp, l.logIndex, l.tx, l.topics.join(","), l.data]))];
  writeFileSync(file, gzipSync(`${lines.join("\n")}\n`));
}

export function readRange(file: string): { header: Header; logs: RawLog[] } {
  const lines = gunzipSync(readFileSync(file)).toString("utf8").trimEnd().split("\n");
  const header = JSON.parse(lines[0] as string) as Header;
  const logs = lines.slice(1).map((line) => {
    const [block, timestamp, logIndex, tx, topics, data] = JSON.parse(line) as [number, number, number, string, string, string];
    return { block, timestamp, logIndex, tx, topics: topics.split(","), data };
  });
  if (logs.length !== header.count) throw new Error(`${file} holds ${logs.length} logs, its header says ${header.count}`);
  return { header, logs };
}

/**
 * Morpho's logs from deployment to `to`, one stored range at a time, in chain order. Ranges not yet
 * stored are fetched from the source and stored first.
 */
export async function* logsUpTo(to: number, dir: string, source: Source, log: (msg: string) => void = () => {}): AsyncGenerator<{ logs: RawLog[]; source: string }> {
  mkdirSync(dir, { recursive: true });
  for (const range of ranges(to)) {
    const file = fileOf(dir, range);
    if (!existsSync(file)) {
      const [from, end] = range;
      const progress = (b: number, n: number) => log(`  ${source.kind} ${from}..${end}: at ${b}, ${n} logs`);
      const logs = source.kind === "hypersync" ? await fetchLogsHypersync(source.token, from, end, progress) : await fetchLogsRpc(from, end, progress);
      logs.sort(byChainOrder);
      const header: Header = {
        schema: "spillway.morpho-logs/1",
        chainId: indexerConfig.chainId,
        address: indexerConfig.morpho.address,
        source: source.kind,
        from,
        to: end,
        count: logs.length,
      };
      writeRange(file, header, logs);
    }
    const { header, logs } = readRange(file);
    yield { logs, source: header.source };
  }
}
