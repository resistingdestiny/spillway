import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildLendingBundle, configHash } from "../src/bundle.js";
import { type CollateralClass, DEFAULT_CONFIG as cfg, severityQuantile, tokenRate } from "../src/config.js";
import { priceVault } from "../src/pricing.js";
import { allCurves, coverLimit, marketCurves, pmlTable, vaultExposure } from "../src/report.js";
import { prepare } from "../src/scenarios.js";
import { FIXTURE, monadBook } from "./fixture.js";

const prep = prepare(monadBook(), cfg);
const curves = allCurves(prep, cfg);
const vaults = vaultExposure(prep, cfg, curves);
const shocks = curves.shocks;

describe("the report CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "lending-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = fileURLToPath(new URL("..", import.meta.url));
  const run = (out: string) => {
    execFileSync("npx", ["tsx", "scripts/report.ts", fileURLToPath(FIXTURE), "--out", out], { cwd: pkg, stdio: "pipe", env: { ...process.env, INIT_CWD: pkg } });
    return readFileSync(out);
  };

  it("writes byte-identical bundles on two runs", () => {
    const a = run(join(dir, "a.json"));
    const b = run(join(dir, "b.json"));
    expect(a.length).toBeGreaterThan(100_000);
    expect(createHash("sha256").update(a).digest("hex")).toBe(createHash("sha256").update(b).digest("hex"));
    expect(a.equals(b)).toBe(true);
  }, 180_000);

  it("carries a manifest that names its inputs", () => {
    const bundle = JSON.parse(readFileSync(join(dir, "a.json"), "utf8"));
    const m = bundle.manifest;
    expect(m.fixture.path).toBe("fixtures/morpho/monad-2026-10-06.json");
    expect(m.fixture.sha256).toBe(createHash("sha256").update(readFileSync(FIXTURE)).digest("hex"));
    expect(m.adapters.path).toBe("fixtures/morpho/monad-2026-10-06.adapters.json");
    expect(m.blocks).toEqual({ from: 111058609, to: 111058632 });
    expect(m.chainId).toBe(143);
    expect(m.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(m.configSha256).toBe(configHash(cfg));
    expect(m.command).toContain("pnpm --filter @spillway/lending run report fixtures/morpho/monad-2026-10-06.json");
  });
});

describe("the bundle", () => {
  const bundle = buildLendingBundle(monadBook(), cfg, {
    fixture: { path: "f", sha256: "" },
    adapters: null,
    chainId: 143,
    blocks: { from: 0, to: 0 },
    takenAt: "",
    commit: "",
    dirty: false,
    configSha256: "",
    command: "",
  });

  it("states headline losses for the thin exit, with always act beside them", () => {
    for (const h of bundle.headline.markets) {
      const m = bundle.markets.find((x) => x.marketId === h.marketId) as (typeof bundle.markets)[number];
      const i = bundle.shocks.indexOf(0.25);
      expect(h.lossUsd.find((x) => x.shock === 0.25)?.lossUsd).toBeCloseTo((m.thin.realisedUsd[i] ?? 0) + (m.thin.unrealisedUsd[i] ?? 0), 2);
      expect(h.alwaysActUsd.find((x) => x.shock === 0.25)?.lossUsd).toBeCloseTo((m.depeg.realisedUsd[i] ?? 0) + (m.depeg.unrealisedUsd[i] ?? 0), 2);
    }
    expect(bundle.summary.headlineScenario).toBe("thin exit");
  });

  it("marks what each researched market's shock means", () => {
    const means = Object.fromEntries(bundle.markets.filter((m) => m.oracleKind).map((m) => [`${m.collateral.symbol}/${m.loan.symbol}`, m.shockMeans]));
    expect(Object.keys(means)).toHaveLength(8);
    expect(means["wstETH/WETH"]).toBe("issuer marks down");
    expect(means["PT-AUSD-8OCT2026/USDC"]).toBe("market price falls");
    for (const m of bundle.markets.filter((x) => !x.oracleKind)) expect(m.shockMeans).toBeNull();
  });

  it("carries a shortfall proof per market that adds up to every borrower's debt at a 100% markdown", () => {
    expect(bundle.shortfalls).toHaveLength(bundle.markets.length);
    for (const s of bundle.shortfalls) {
      const m = bundle.markets.find((x) => x.marketId === s.marketId) as (typeof bundle.markets)[number];
      const all = s.proofs.find((p) => p.shock === 1);
      // Morpho rounds debt up, so a position with borrow shares worth under one base unit still owes one.
      expect(all?.borrowers.length).toBeGreaterThanOrEqual(m.borrowers);
      expect(all?.shortfallUsd).toBeCloseTo(m.debtUsd, -1);
      for (const p of s.proofs) expect([...p.borrowers].sort()).toEqual(p.borrowers);
    }
  });

  it("names its data sources", () => {
    expect(bundle.config.sources.map((s) => s.name)).toEqual(expect.arrayContaining(["Morpho API", "Monad RPC", "DefiLlama protocols", "KyberSwap", "Pendle hosted SDK"]));
  });
});

describe("probable maximum loss", () => {
  const pml = pmlTable(prep, cfg, curves);

  it("ranks tokens by the loss their failure puts on depositors", () => {
    for (let i = 1; i < pml.length; i++) expect(pml[i - 1]?.pmlUsd).toBeGreaterThanOrEqual(pml[i]?.pmlUsd as number);
    expect(pml.map((r) => r.rank)).toEqual(pml.map((_, i) => i + 1));
  });

  it("at a 100% fall loses every dollar lent against the token", () => {
    for (const r of pml) expect(r.pmlUsd).toBeCloseTo(r.debtUsd, -1);
  });

  it("adds up across the market curves", () => {
    const markets = marketCurves(prep, cfg, curves);
    for (const r of pml) {
      const at = shocks.indexOf(0.25);
      const sum = markets.filter((m) => m.collateral.address === r.token).reduce((a, m) => a + (m.thin.realisedUsd[at] ?? 0) + (m.thin.unrealisedUsd[at] ?? 0), 0);
      expect(r.lossUsd.find((d) => d.shock === 0.25)?.lossUsd).toBeCloseTo(sum, 0);
      const always = markets.filter((m) => m.collateral.address === r.token).reduce((a, m) => a + (m.depeg.realisedUsd[at] ?? 0) + (m.depeg.unrealisedUsd[at] ?? 0), 0);
      expect(r.alwaysActUsd.find((d) => d.shock === 0.25)?.lossUsd).toBeCloseTo(always, 0);
    }
  });
});

describe("vault exposure and cover", () => {
  it("names the largest vaults through their adapters", () => {
    const names = vaults.slice(0, 3).map((v) => v.name);
    expect(names).toContain("Hyperithm USDC Apex");
    expect(names).toContain("Steakhouse Prime ETH");
  });

  it("splits each market's loss between vaults and other suppliers without losing a cent", () => {
    const markets = marketCurves(prep, cfg, curves);
    for (const m of markets) {
      for (const s of m.split) {
        const i = shocks.indexOf(s.shock);
        const loss = (m.thin.realisedUsd[i] ?? 0) + (m.thin.unrealisedUsd[i] ?? 0);
        const split = s.vaults.reduce((a, v) => a + v.lossUsd, 0) + s.othersUsd;
        expect(Math.abs(split - loss)).toBeLessThan(0.01 * (s.vaults.length + 2));
      }
    }
  });

  it("sets the cover limit at the worst single token's loss at that fall", () => {
    for (const v of vaults) {
      for (const shock of cfg.reportShocks) {
        const i = shocks.indexOf(shock);
        const { limitUsd, token } = coverLimit(v, shocks, shock);
        for (const t of v.byToken) expect(limitUsd).toBeGreaterThanOrEqual(t.lossUsd[i] as number);
        if (limitUsd > 0) expect(v.byToken.find((t) => t.token === token)?.lossUsd[i]).toBe(limitUsd);
      }
    }
  });

  it("never needs more cover than the vault supplies", () => {
    for (const v of vaults) for (const t of v.byToken) for (const l of [...t.lossUsd, ...t.alwaysActUsd]) expect(l).toBeLessThanOrEqual(v.supplyUsd + 0.01);
  });
});

describe("pricing", () => {
  const priced = vaults.slice(0, 8).map((v) => priceVault(prep, cfg, v));

  it("sums p(class) x the mean loss over the class's incident falls, under the thin exit", () => {
    for (const p of priced) {
      for (const t of p.tokens) {
        const rate = tokenRate(t.symbol, cfg);
        expect(t.falls.map((f) => f.fall)).toEqual(rate.incidents.map((i) => i.fall));
        const meanLoss = t.falls.reduce((a, f) => a + f.lossUsd, 0) / t.falls.length;
        expect(t.lossUsd).toBeCloseTo(meanLoss, 1);
        expect(t.expectedLossUsd).toBeCloseTo(t.annualProbability * t.lossUsd, 0);
      }
      expect(p.expectedLossUsd).toBeCloseTo(p.tokens.reduce((a, t) => a + t.expectedLossUsd, 0), 0);
      expect(p.expectedLossRangeUsd[0]).toBeLessThanOrEqual(p.expectedLossUsd);
      expect(p.expectedLossRangeUsd[1]).toBeGreaterThanOrEqual(p.expectedLossUsd);
    }
  });

  it("sets the limit at the worst token's loss at its class's 90th percentile fall", () => {
    for (const p of priced) {
      for (const t of p.tokens) expect(t.limitFall).toBeCloseTo(severityQuantile(cfg.pricing.classes[t.class as CollateralClass], 0.9), 9);
      expect(p.limitUsd).toBe(Math.max(0, ...p.tokens.map((t) => t.limitLossUsd)));
      // The cover pays at most the limit, so its expected loss is no more than the depositors'.
      expect(p.coverExpectedLossUsd).toBeLessThanOrEqual(p.expectedLossUsd + 0.01);
    }
  });

  it("prices at the cover's expected loss rate x (1 + risk load) + capital charge", () => {
    for (const p of priced) {
      if (p.limitUsd === 0) continue;
      expect(p.rate).toBeCloseTo((p.coverExpectedLossUsd / p.limitUsd) * (1 + cfg.pricing.riskLoad) + cfg.pricing.capitalCharge, 6);
      expect(p.rateHigh).toBeGreaterThanOrEqual(p.rate);
      expect(p.annualPremiumUsd).toBeCloseTo(p.rate * p.limitUsd, 0);
    }
  });

  it("flags only the vaults that lend against a token the research does not cover", () => {
    for (const p of priced) {
      expect(p.placeholder).toBe(p.tokens.some((t) => t.placeholder));
      expect(p.placeholderTokens).toEqual(p.tokens.filter((t) => t.placeholder).map((t) => t.symbol));
    }
    const steakhouse = priced.find((p) => p.name === "Steakhouse Prime ETH");
    expect(steakhouse?.placeholder).toBe(false);
  });
});
