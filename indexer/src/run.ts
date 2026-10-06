// Replay from Morpho's deployment to one or more blocks, handing the book over at the end of each.

import { decode } from "./events.js";
import { logsUpTo, type Source } from "./logs.js";
import { apply, newBook, type Book } from "./replay.js";

export interface RunStats {
  logs: number;
  /** Which source fetched the stored ranges, by count of ranges. */
  sources: Record<string, number>;
}

/**
 * Replay to each block in `stops` (ascending). `atStop` sees the book as it stands at the end of that
 * block, before any later log, and must read it before returning: the same book keeps moving.
 */
export async function replayTo(stops: number[], dir: string, source: Source, atStop: (block: number, book: Book) => void | Promise<void>, log?: (msg: string) => void): Promise<RunStats> {
  const sorted = [...stops].sort((a, b) => a - b);
  const last = sorted[sorted.length - 1];
  if (last === undefined) throw new Error("no block to replay to");
  const book = newBook();
  const stats: RunStats = { logs: 0, sources: {} };
  let next = 0;
  for await (const range of logsUpTo(last, dir, source, log)) {
    stats.sources[range.source] = (stats.sources[range.source] ?? 0) + 1;
    for (const raw of range.logs) {
      while (next < sorted.length && raw.block > (sorted[next] as number)) await atStop(sorted[next++] as number, book);
      stats.logs++;
      const e = decode(raw);
      if (e) apply(book, e);
    }
  }
  while (next < sorted.length) await atStop(sorted[next++] as number, book);
  return stats;
}
