import { type LendingBundle, buildLendingBundle } from "@spillway/lending";
import { beforeAll, describe, expect, it } from "vitest";
import { type Engine, loadEngine } from "../src/engine.js";
import type { TestnetCover } from "../src/testnet.js";
import { type Tool, ToolInputError, makeTools } from "../src/tools.js";

let e: Engine;
let tools: Tool[];
let bundle: LendingBundle;

const fakeCover: TestnetCover = {
  network: "monad-testnet",
  block: 68_976_356,
  vault: { address: "0x8af0Cc6D3bD243509F3c7cBaF4993456E9cd1653", freeCapital: 329_794.32, activeLimit: 329_794.32, capacity: 0, paidOutTotal: 57_634.68 },
  policy: { id: 1, holder: "0x4f521155D6786469583C1ED5F40Cb0Ec02DEe402", limit: 387_429, deductible: 0, paidSoFar: 57_634.68, claimableNow: 0, claimableShortfallNow: 0, attached: true },
  market: { pair: "twstETH/tUSD", replayOf: "wstETH/WETH", unhealthyBorrowers: 16, borrowers: 17, provableShortfall: 59_094.63 },
  lastClaim: null,
};

beforeAll(() => {
  e = loadEngine();
  tools = makeTools(e, async () => fakeCover);
  // The lending engine's own published output, built the way the report CLI builds it.
  bundle = buildLendingBundle(e.book, e.cfg, {
    fixture: { path: "", sha256: "" },
    adapters: null,
    chainId: e.book.chainId,
    blocks: { from: e.book.blocks.from.number, to: e.book.blocks.to.number },
    takenAt: e.book.takenAt,
    commit: "",
    dirty: false,
    configSha256: "",
    command: "",
  });
});

const run = async (name: string, input: Record<string, unknown>) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t.run(input);
};
const WSTETH_WETH = "0x8bdb7d2c5024d349772884afb3c5c409bc8de58ed63d79618bf48fb57b595060";
const at = (xs: number[], shock: number) => xs[bundle.shocks.indexOf(shock)] ?? NaN;

describe("the snapshot", () => {
  it("is the 6 October 2026 book, read at its later block", () => {
    expect(e.block).toBe(111058632);
    expect(e.date).toBe("6 October 2026");
  });
});

describe("list_markets", () => {
  it("lists the markets with borrowers, largest first, as the engine sizes them", async () => {
    const r = (await run("list_markets", { limit: 5 })).result as Record<string, any>;
    expect(r.snapshotBlock).toBe(111058632);
    expect(r.marketsWithBorrowers).toBe(bundle.summary.marketsWithBorrowers);
    expect(r.totalBorrowedUsd).toBeCloseTo(bundle.summary.debtUsd, 1);
    expect(r.totalSuppliedUsd).toBeCloseTo(bundle.summary.supplyUsd, 1);
    expect(r.badDebtRecordedUsd).toBe(0);
    expect(r.markets.map((m: any) => m.id)).toEqual(bundle.headline.markets.map((m) => m.marketId));
    const top = r.markets[0];
    expect(top).toMatchObject({ pair: "wstETH/WETH", lltv: 0.945, borrowedUsd: bundle.headline.markets[0]?.debtUsd, oracleKind: "exchange-rate", markdownMeans: "issuer marks down" });
    expect(top.exitDepthUsd).toBeCloseTo(6146, 0);
  });

  it("filters by collateral", async () => {
    const r = (await run("list_markets", { collateral: "wsteth", limit: 100 })).result as Record<string, any>;
    expect(r.matching).toBe(bundle.markets.filter((m) => m.collateral.symbol === "wstETH").length);
  });
});

describe("stress_market", () => {
  it("matches the engine's thin exit curve and split at 25%", async () => {
    const out = await run("stress_market", { market: "wstETH/WETH", markdown_pct: 25 });
    const r = out.result as Record<string, any>;
    const m = bundle.markets.find((x) => x.marketId === WSTETH_WETH);
    if (!m) throw new Error("no market");
    expect(out.summary).toBe("Stressed wstETH/WETH at 25%");
    expect(r.writtenOffUsd).toBeCloseTo(at(m.thin.realisedUsd, 0.25), 1);
    expect(r.notWrittenOffUsd).toBeCloseTo(at(m.thin.unrealisedUsd, 0.25), 1);
    expect(r.lossToSuppliersUsd).toBeCloseTo(5_905_489.77, 1);
    const split = m.split.find((s) => s.shock === 0.25);
    for (const v of split?.vaults ?? []) {
      const mine = r.lossByVault.find((x: any) => x.vault === v.name);
      expect(mine.lossUsd).toBeCloseTo(v.lossUsd, 1);
    }
    expect(r.lossByVault.find((x: any) => x.vault === "other suppliers").lossUsd).toBeCloseTo(split?.othersUsd ?? NaN, 1);
    expect(r.lossByVault[0]).toMatchObject({ vault: "Steakhouse Prime ETH", shareOfLoss: "97.6%" });
  });

  it("matches the loss the engine puts on Steakhouse Prime ETH at 20%", async () => {
    const r = (await run("stress_market", { market: WSTETH_WETH, markdown_pct: 20 })).result as Record<string, any>;
    const v = bundle.vaults.find((x) => x.name === "Steakhouse Prime ETH");
    const t = v?.byToken.find((x) => x.symbol === "wstETH");
    expect(r.lossByVault[0].vault).toBe("Steakhouse Prime ETH");
    expect(r.lossByVault[0].lossUsd).toBeCloseTo(at(t?.lossUsd ?? [], 0.2), 1);
    expect(r.writtenOffUsd).toBe(0);
  });

  it("runs the comparison scenarios", async () => {
    const m = bundle.markets.find((x) => x.marketId === WSTETH_WETH);
    if (!m) throw new Error("no market");
    const act = (await run("stress_market", { market: "wstETH/WETH", markdown_pct: 25, scenario: "always_act" })).result as Record<string, any>;
    expect(act.lossToSuppliersUsd).toBeCloseTo(at(m.depeg.realisedUsd, 0.25) + at(m.depeg.unrealisedUsd, 0.25), 1);
    const held = (await run("stress_market", { market: "wstETH/WETH", markdown_pct: 25, scenario: "oracle_holds" })).result as Record<string, any>;
    expect(held.notWrittenOffUsd).toBeCloseTo(at(m.hidden.unrealisedUsd, 0.25), 1);
  });

  it("resolves a collateral symbol to its largest market and rejects what it cannot find", async () => {
    const r = (await run("stress_market", { market: "earnAUSD", markdown_pct: 25 })).result as Record<string, any>;
    expect(r.pair).toBe("earnAUSD/USDC");
    await expect(run("stress_market", { market: "DOGE/USDC", markdown_pct: 25 })).rejects.toBeInstanceOf(ToolInputError);
    await expect(run("stress_market", { market: "wstETH/WETH", markdown_pct: 250 })).rejects.toBeInstanceOf(ToolInputError);
  });
});

describe("pml_ranking", () => {
  it("is the engine's PML table", async () => {
    const r = (await run("pml_ranking", { limit: 5 })).result as Record<string, any>;
    expect(r.ranking.map((x: any) => x.token)).toEqual(bundle.headline.pml.map((x) => x.symbol));
    expect(r.ranking.map((x: any) => x.pmlUsd)).toEqual(bundle.headline.pml.map((x) => x.pmlUsd));
    expect(r.ranking[0]).toMatchObject({ rank: 1, token: "wstETH", firstLossAtMarkdown: "6%" });
    expect(r.ranking[0].lossAtMarkdownUsd["25%"]).toBe(bundle.pml[0]?.lossUsd.find((x) => x.shock === 0.25)?.lossUsd);
  });
});

describe("vault_cover", () => {
  it("is the engine's price for August USDC V2", async () => {
    const out = await run("vault_cover", { vault: "August USDC V2" });
    const r = out.result as Record<string, any>;
    const p = bundle.pricing.find((x) => x.name === "August USDC V2");
    if (!p) throw new Error("no price");
    expect(out.summary).toBe("Priced cover for August USDC V2");
    expect(r.cover).toMatchObject({ limitUsd: p.limitUsd, limitSetByToken: "earnAUSD", annualPremiumUsd: p.annualPremiumUsd, expectedYearlyLossUsd: p.expectedLossUsd });
    expect(r.cover.ratePerYearOnLimit).toBe("40.8%");
    const limit = bundle.cover.find((x) => x.name === "August USDC V2")?.limits.find((l) => l.shock === 0.25);
    expect(r.coverNeededAtMarkdownUsd).toBe(limit?.limitUsd);
  });

  it("finds Steakhouse Prime ETH by part of its name and prices it at 0.71% of supply", async () => {
    const r = (await run("vault_cover", { vault: "steakhouse prime", markdown_pct: 20 })).result as Record<string, any>;
    expect(r.vault).toBe("Steakhouse Prime ETH");
    expect(r.cover.premiumAsShareOfSupply).toBe("0.71%");
    const t = bundle.vaults.find((x) => x.name === "Steakhouse Prime ETH")?.byToken.find((x) => x.symbol === "wstETH");
    expect(r.lossByTokenAtMarkdown[0]).toMatchObject({ token: "wstETH", lossUsd: at(t?.lossUsd ?? [], 0.2) });
    await expect(run("vault_cover", { vault: "No Such Vault" })).rejects.toBeInstanceOf(ToolInputError);
  });
});

describe("shortfall_proof", () => {
  it("is the engine's proof at each report markdown", async () => {
    const proofs = bundle.shortfalls.find((x) => x.marketId === WSTETH_WETH)?.proofs ?? [];
    expect(proofs.length).toBeGreaterThan(0);
    for (const p of proofs) {
      const r = (await run("shortfall_proof", { market: "wstETH/WETH", markdown_pct: p.shock * 100 })).result as Record<string, any>;
      expect(r.shortfallBaseUnits).toBe(p.shortfall);
      expect(r.oraclePriceRaw).toBe(p.priceRaw);
      expect(r.shortfallUsd).toBe(p.shortfallUsd);
      expect(r.borrowersToName).toBe(p.borrowers.length);
      expect(r.borrowers).toEqual(p.borrowers.slice(0, 20));
    }
    const r = (await run("shortfall_proof", { market: "wstETH/WETH", markdown_pct: 25 })).result as Record<string, any>;
    expect(r.borrowersToName).toBe(16);
  });
});

describe("testnet_cover", () => {
  it("passes the live reading through with its block", async () => {
    const out = await run("testnet_cover", {});
    expect(out.summary).toBe("Read the testnet cover at block 68,976,356");
    expect((out.result as any).policy.paidSoFar).toBe(57_634.68);
  });
});
