import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBook } from "@spillway/lending";
import { describe, expect, it } from "vitest";
import { decode, type RawLog } from "../src/events.js";
import { apply, newBook } from "../src/replay.js";
import { buildSnapshot } from "../src/snapshot.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "market-67c3a8f2.json"), "utf8")) as { market: string; block: number; logs: [number, number, number, string, string, string][] };

describe("snapshot", () => {
  it("is a file lending/ loads, with the replayed shares", () => {
    const book = newBook();
    for (const [block, timestamp, logIndex, tx, topics, data] of fixture.logs) {
      const e = decode({ block, timestamp, logIndex, tx, topics: topics.split(","), data } as RawLog);
      if (e) apply(book, e);
    }
    const m = book.markets.get(fixture.market)!;
    // Token metadata and the oracle price as eth_call would return them; no labels.
    const meta = {
      block: fixture.block,
      tokens: new Map([
        [m.loanToken, { symbol: "LOAN", decimals: 6 }],
        [m.collateralToken, { symbol: "COLL", decimals: 18 }],
      ]),
      prices: new Map([[m.id, 10n ** 24n]]),
    };
    const snap = buildSnapshot(book, { number: fixture.block, timestamp: 1791295930 }, meta, null, { logs: "rpc", rpc: "", morpho: "", fromBlock: 0, labels: null });
    const loaded = loadBook(snap);
    expect(loaded.markets.map((x) => x.id)).toEqual([fixture.market]);
    expect(loaded.markets[0]?.totals.borrowShares).toBe(m.totalBorrowShares);
    expect(loaded.markets[0]?.price).toBeCloseTo(1, 12);
    const open = [...book.positions.get(m.id)!.values()].filter((p) => p.supplyShares || p.borrowShares || p.collateral);
    expect(loaded.positions).toHaveLength(open.length);
    expect(loaded.positions.reduce((a, p) => a + p.supplyShares, 0n)).toBe(m.totalSupplyShares);
  });
});
