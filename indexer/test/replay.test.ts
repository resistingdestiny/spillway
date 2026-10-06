import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decode, TOPIC0, type MorphoEvent, type RawLog } from "../src/events.js";
import { apply, newBook, type Book } from "../src/replay.js";

// Market 0x67c3a8f2... on Monad: every log from deployment to block 111058632, and Morpho's storage
// for it at that block, recorded by scripts/record-fixture.ts.
interface Fixture {
  market: string;
  block: number;
  logs: [number, number, number, string, string, string][];
  storage: {
    market: Record<"totalSupplyAssets" | "totalSupplyShares" | "totalBorrowAssets" | "totalBorrowShares" | "lastUpdate" | "fee", string>;
    positions: Record<string, { supplyShares: string; borrowShares: string; collateral: string }>;
  };
}
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "market-67c3a8f2.json"), "utf8")) as Fixture;
const logs: RawLog[] = fixture.logs.map(([block, timestamp, logIndex, tx, topics, data]) => ({ block, timestamp, logIndex, tx, topics: topics.split(","), data }));

function replay(raw: RawLog[]): Book {
  const book = newBook();
  for (const l of raw) {
    const e = decode(l);
    if (e) apply(book, e);
  }
  return book;
}

describe("decode", () => {
  it("reads onBehalf from the topic Morpho indexes it in", () => {
    // Withdraw and Borrow index (id, onBehalf, receiver) and keep the caller in data; Supply indexes (id, caller, onBehalf).
    const withdraw = logs.find((l) => l.topics[0] === TOPIC0.Withdraw) as RawLog;
    const supply = logs.find((l) => l.topics[0] === TOPIC0.Supply) as RawLog;
    const w = decode(withdraw) as Extract<MorphoEvent, { kind: "Withdraw" }>;
    const s = decode(supply) as Extract<MorphoEvent, { kind: "Supply" }>;
    expect(w.onBehalf).toBe(`0x${(withdraw.topics[2] as string).slice(-40)}`);
    expect(w.assets).toBe(BigInt(`0x${withdraw.data.slice(66, 130)}`));
    expect(s.onBehalf).toBe(`0x${(supply.topics[3] as string).slice(-40)}`);
    expect(s.assets).toBe(BigInt(`0x${supply.data.slice(2, 66)}`));
  });

  it("skips events the replay does not read", () => {
    expect(decode({ block: 1, timestamp: 1, logIndex: 0, tx: "0x", topics: ["0x167d3e9c1016ab80e58802ca9da10ce5c6a0f4debc46a2e7a2cd9e56899a4fb5"], data: "0x" })).toBeNull();
  });
});

describe("replay of a recorded market", () => {
  const book = replay(logs);
  const m = book.markets.get(fixture.market);

  it("covers every kind of event the market has seen", () => {
    const kinds = new Set(logs.map((l) => decode(l)?.kind));
    for (const k of ["CreateMarket", "AccrueInterest", "Supply", "Withdraw", "Borrow", "Repay", "SupplyCollateral", "WithdrawCollateral", "Liquidate"]) expect(kinds).toContain(k);
  });

  it("recomputes every event from the replayed state", () => {
    expect(book.checks.failed).toEqual([]);
    expect(book.checks.passed).toBeGreaterThan(logs.length);
  });

  it("ends with exactly Morpho's stored totals", () => {
    const s = fixture.storage.market;
    expect(m).toBeDefined();
    expect(String(m?.totalSupplyAssets)).toBe(s.totalSupplyAssets);
    expect(String(m?.totalSupplyShares)).toBe(s.totalSupplyShares);
    expect(String(m?.totalBorrowAssets)).toBe(s.totalBorrowAssets);
    expect(String(m?.totalBorrowShares)).toBe(s.totalBorrowShares);
    expect(String(m?.lastUpdate)).toBe(s.lastUpdate);
    expect(String(m?.fee)).toBe(s.fee);
  });

  it("ends with exactly Morpho's stored positions", () => {
    const ours = book.positions.get(fixture.market) as Map<string, { supplyShares: bigint; borrowShares: bigint; collateral: bigint }>;
    for (const [user, p] of Object.entries(fixture.storage.positions)) {
      const q = ours.get(user);
      expect({ user, supplyShares: String(q?.supplyShares), borrowShares: String(q?.borrowShares), collateral: String(q?.collateral) }).toEqual({ user, ...p });
    }
  });

  it("notices a missing log", () => {
    // Drop the first AccrueInterest after borrowing began: the next accrual is then computed on less debt.
    const firstBorrow = logs.findIndex((l) => l.topics[0] === TOPIC0.Borrow);
    const i = logs.findIndex((l, j) => j > firstBorrow && l.topics[0] === TOPIC0.AccrueInterest && BigInt(`0x${l.data.slice(66, 130)}`) > 0n);
    let failed: number;
    try {
      failed = replay(logs.filter((_, j) => j !== i)).checks.failed.length;
    } catch {
      failed = Infinity;
    }
    expect(failed).toBeGreaterThan(0);
  });
});
