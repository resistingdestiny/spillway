// The same logs over plain JSON-RPC, for runs without a HyperSync token, and the few eth_calls the
// snapshot needs (token decimals and symbols, oracle prices, the block's timestamp).

import { indexerConfig } from "./config.js";
import { TOPIC0, type RawLog } from "./events.js";

const hex = (n: number | bigint) => `0x${n.toString(16)}`;

let turn = 0;

/** One JSON-RPC request. Given several URLs, each attempt goes to the next one. */
export async function rpc<T>(method: string, params: unknown[], urls: string | readonly string[] = indexerConfig.rpc.url): Promise<T> {
  const list = typeof urls === "string" ? [urls] : urls;
  const first = turn++;
  for (let attempt = 0; ; attempt++) {
    const url = list[(first + attempt) % list.length] as string;
    let failure: string;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = (await res.json().catch(() => ({}))) as { result?: T; error?: { code: number; message: string } };
      if (body.result !== undefined) return body.result;
      const message = body.error?.message ?? `HTTP ${res.status}`;
      // A response over the size cap is the caller's to split, and a revert is an answer. Anything
      // else (rate limits, timeouts) is retried.
      if (/size exceeded|too large|limited to|exceeded max allowed range/i.test(message)) throw new RangeError(message);
      if (/revert/i.test(message)) throw new Error(`${method}: ${message}`);
      failure = message;
    } catch (e) {
      if (e instanceof RangeError || (e instanceof Error && e.message.startsWith(`${method}: `))) throw e;
      failure = String(e);
    }
    if (attempt >= 7) throw new Error(`${method} failed ${attempt + 1} times: ${failure}`);
    await new Promise((r) => setTimeout(r, Math.min(20_000, 500 * 2 ** attempt)));
  }
}

export async function blockAt(n: number | "latest"): Promise<{ number: number; timestamp: number }> {
  const b = await rpc<{ number: string; timestamp: string }>("eth_getBlockByNumber", [n === "latest" ? n : hex(n), false]);
  return { number: Number(b.number), timestamp: Number(b.timestamp) };
}

interface RpcLog {
  blockNumber: string;
  blockTimestamp?: string;
  logIndex: string;
  transactionHash: string;
  topics: string[];
  data: string;
}

/** Every Morpho Blue log the replay reads, in blocks from..to inclusive, in chain order. */
export async function fetchLogsRpc(from: number, to: number, progress?: (block: number, logs: number) => void): Promise<RawLog[]> {
  const out: RawLog[] = [];
  const timestamps = new Map<number, number>();
  let span: number = indexerConfig.rpc.logSpan;
  for (let start = from; start <= to; ) {
    const end = Math.min(to, start + span - 1);
    let logs: RpcLog[];
    try {
      logs = await rpc<RpcLog[]>("eth_getLogs", [
        { address: indexerConfig.morpho.address, topics: [Object.values(TOPIC0)], fromBlock: hex(start), toBlock: hex(end) },
      ]);
    } catch (e) {
      if (e instanceof RangeError && span > 1) {
        span = Math.ceil(span / 2);
        continue;
      }
      throw e;
    }
    for (const l of logs) {
      const block = Number(l.blockNumber);
      // rpc1 adds blockTimestamp to each log; ask for the block when a node does not.
      if (l.blockTimestamp) timestamps.set(block, Number(l.blockTimestamp));
      else if (!timestamps.has(block)) timestamps.set(block, (await blockAt(block)).timestamp);
      out.push({
        block,
        timestamp: timestamps.get(block) as number,
        logIndex: Number(l.logIndex),
        tx: l.transactionHash.toLowerCase(),
        topics: l.topics.map((t) => t.toLowerCase()),
        data: l.data.toLowerCase(),
      });
    }
    start = end + 1;
    progress?.(end, out.length);
    // Sparse stretches need fewer requests: grow back after a success.
    if (logs.length < 2_500) span = Math.min(indexerConfig.rpc.logSpan * 8, span * 2);
  }
  return out;
}

/** eth_call at a block, returning the raw result, or null if it reverts. */
export async function call(to: string, data: string, block: number): Promise<string | null> {
  try {
    return await rpc<string>("eth_call", [{ to, data }, hex(block)], indexerConfig.rpc.callUrls);
  } catch (e) {
    if (e instanceof Error && /revert/i.test(e.message)) return null;
    throw e;
  }
}
