// Morpho Blue's logs from Envio HyperSync.
//
// One query asks for every log of the Morpho contract whose topic0 is one of the events the replay
// reads, with the block number and timestamp joined in. HyperSync answers as much of the range as it
// can per request and returns nextBlock, so the loop pages until it reaches the end block.

import { HypersyncClient } from "@envio-dev/hypersync-client";
import { indexerConfig } from "./config.js";
import { TOPIC0, type RawLog } from "./events.js";

export function hypersyncToken(): string | null {
  return process.env[indexerConfig.hypersync.tokenEnv] || null;
}

/** Every Morpho Blue log the replay reads, in blocks from..to inclusive, in chain order. */
export async function fetchLogsHypersync(apiToken: string, from: number, to: number, progress?: (block: number, logs: number) => void): Promise<RawLog[]> {
  const client = new HypersyncClient({ url: indexerConfig.hypersync.url, apiToken });
  const out: RawLog[] = [];
  // HyperSync's toBlock is exclusive.
  const end = to + 1;
  for (let next = from; next < end; ) {
    const res = await client.get({
      fromBlock: next,
      toBlock: end,
      logs: [{ address: [indexerConfig.morpho.address], topics: [Object.values(TOPIC0)] }],
      fieldSelection: {
        log: ["BlockNumber", "LogIndex", "TransactionHash", "Data", "Topic0", "Topic1", "Topic2", "Topic3"],
        block: ["Number", "Timestamp"],
      },
    });
    const timestamps = new Map(res.data.blocks.map((b) => [b.number, b.timestamp]));
    for (const l of res.data.logs) {
      const block = l.blockNumber ?? -1;
      const timestamp = timestamps.get(block);
      if (timestamp === undefined) throw new Error(`HyperSync returned a log in block ${block} without its block`);
      out.push({
        block,
        timestamp,
        logIndex: l.logIndex ?? -1,
        tx: (l.transactionHash ?? "").toLowerCase(),
        topics: l.topics.filter((t): t is string => !!t).map((t) => t.toLowerCase()),
        data: (l.data ?? "0x").toLowerCase(),
      });
    }
    if (res.nextBlock <= next) throw new Error(`HyperSync made no progress at block ${next}`);
    next = res.nextBlock;
    progress?.(next, out.length);
  }
  return out;
}
