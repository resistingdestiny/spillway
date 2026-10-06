import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG as cfg } from "../src/config.js";
import { prepare, runScenario } from "../src/scenarios.js";
import { collateralAssets, debtAssets, markedDown, provableShortfall, shortfallWitness } from "../src/shortfall.js";
import type { LendingBook, Market, Position } from "../src/snapshot.js";
import { monadBook } from "./fixture.js";

const book = monadBook();
const prep = prepare(book, cfg);
const withBorrowers = prep.markets.filter((pm) => pm.borrowers.length > 0);

describe("Morpho's arithmetic", () => {
  // One market, two borrowers, in a 6-decimal loan token and an 18-decimal collateral.
  const market = {
    id: "0xm",
    totals: { borrowAssets: 1_000_000n, borrowShares: 1_000_000n * 10n ** 6n, supplyAssets: 0n, supplyShares: 0n, collateral: 0n },
  } as unknown as Market;
  const pos = (user: string, borrowShares: bigint, collateral: bigint) =>
    ({ marketId: "0xm", user, borrowShares, collateral, borrowAssets: 0n, supplyAssets: 0n, supplyShares: 0n, apiHealthFactor: null }) as Position;
  const tiny: LendingBook = {
    chainId: 1,
    takenAt: "",
    blocks: { from: { number: 0, timestamp: 0 }, to: { number: 0, timestamp: 0 } },
    markets: [market],
    positions: [pos("0xa", 600_000n * 10n ** 6n, 10n ** 18n), pos("0xb", 400_000n * 10n ** 6n, 10n ** 18n)],
    vaults: new Map(),
    adapters: new Map(),
  };
  // 1 collateral token = 0.5 loan tokens: price = 0.5e6 / 1e18 * 1e36.
  const price = 5n * 10n ** 23n;

  it("rounds debt up and collateral value down, as Morpho does", () => {
    // 600,000e6 shares of (1,000,000 + 1) assets over (1e12 + 1e6) shares: 599,999.999..., rounded up.
    expect(debtAssets(market, tiny.positions[0] as Position)).toBe(600_000n);
    expect(collateralAssets(tiny.positions[0] as Position, price)).toBe(500_000n);
    // 2e12 - 1 base units of collateral are worth 0.9999995 loan base units: rounded down to 0.
    expect(collateralAssets(pos("0xc", 0n, 2n * 10n ** 12n - 1n), price)).toBe(0n);
    expect(collateralAssets(pos("0xc", 0n, 2n * 10n ** 12n), price)).toBe(1n);
  });

  it("sums max(0, debt - collateral x price) over the named borrowers", () => {
    const s = provableShortfall(tiny, "0xm", price, ["0xa", "0xb"]);
    expect(s.borrowers.map((b) => b.shortfall)).toEqual([100_000n, 0n]);
    expect(s.shortfall).toBe(100_000n);
    expect(shortfallWitness(tiny, "0xm", price).borrowers.map((b) => b.user)).toEqual(["0xa"]);
    // A borrower named twice, or out of order, is refused.
    expect(() => provableShortfall(tiny, "0xm", price, ["0xa", "0xa"])).toThrow();
    expect(() => provableShortfall(tiny, "0xm", price, ["0xb", "0xa"])).toThrow();
    // A name with no position adds nothing.
    expect(provableShortfall(tiny, "0xm", price, ["0xa", "0xz"]).shortfall).toBe(100_000n);
  });

  it("marks the price down in exact integers", () => {
    expect(markedDown(10n ** 36n, 0.25)).toBe(75n * 10n ** 34n);
    expect(markedDown(10n ** 36n, 0)).toBe(10n ** 36n);
    expect(markedDown(10n ** 36n, 1)).toBe(0n);
    expect(() => markedDown(1n, 1.5)).toThrow();
  });
});

describe("provable shortfall on the 6 October book", () => {
  it("is under a cent today: only one dust borrower owes more than its collateral in a priced market", () => {
    let usd = 0;
    for (const pm of withBorrowers.filter((m) => m.loanUsd > 0)) {
      const s = shortfallWitness(book, pm.market.id, pm.market.priceRaw as bigint);
      usd += (Number(s.shortfall) / 10 ** pm.market.loan.decimals) * pm.loanUsd;
    }
    expect(usd).toBeGreaterThan(0);
    expect(usd).toBeLessThan(0.01);
  });

  it("equals the scenario's unrealised loss when nobody liquidates, at every report markdown", () => {
    for (const pm of withBorrowers) {
      const scale = 10 ** pm.market.loan.decimals;
      const debt = pm.borrowers.reduce((a, b) => a + b.debt, 0);
      for (const shock of cfg.reportShocks) {
        const run = runScenario(prep, cfg, { kind: "nobody", token: pm.market.collateral?.address as string, shock }).find((r) => r.marketId === pm.market.id);
        const proof = shortfallWitness(book, pm.market.id, markedDown(pm.market.priceRaw as bigint, shock));
        const proved = Number(proof.shortfall) / scale;
        // The scenario runs in doubles on the API's per-position debt, the proof in integers on shares.
        expect(Math.abs(proved - (run?.unrealised ?? 0))).toBeLessThanOrEqual(1e-9 * Math.max(1, debt) + (2 * pm.borrowers.length) / scale);
      }
    }
  });

  it("names exactly the borrowers that are short, and naming everyone proves no more", () => {
    const pm = withBorrowers.find((m) => m.market.collateral?.symbol === "wstETH" && m.market.loan.symbol === "WETH") as (typeof withBorrowers)[number];
    const price = markedDown(pm.market.priceRaw as bigint, 0.25);
    const witness = shortfallWitness(book, pm.market.id, price);
    expect(witness.borrowers.length).toBeGreaterThan(0);
    for (const b of witness.borrowers) expect(b.shortfall).toBeGreaterThan(0n);
    const everyone = pm.borrowers.map((b) => b.user).sort();
    expect(provableShortfall(book, pm.market.id, price, everyone).shortfall).toBe(witness.shortfall);
    const partial = provableShortfall(book, pm.market.id, price, witness.borrowers.slice(1).map((b) => b.user));
    expect(partial.shortfall).toBeLessThan(witness.shortfall);
  });
});
