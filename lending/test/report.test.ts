import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { configHash } from "../src/bundle.js";
import { DEFAULT_CONFIG as cfg } from "../src/config.js";
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
      const sum = markets.filter((m) => m.collateral.address === r.token).reduce((a, m) => a + (m.depeg.realisedUsd[at] ?? 0) + (m.depeg.unrealisedUsd[at] ?? 0), 0);
      expect(r.depegUsd.find((d) => d.shock === 0.25)?.lossUsd).toBeCloseTo(sum, 0);
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
        const loss = (m.depeg.realisedUsd[i] ?? 0) + (m.depeg.unrealisedUsd[i] ?? 0);
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
        for (const t of v.byToken) expect(limitUsd).toBeGreaterThanOrEqual(t.depegUsd[i] as number);
        if (limitUsd > 0) expect(v.byToken.find((t) => t.token === token)?.depegUsd[i]).toBe(limitUsd);
      }
    }
  });

  it("never needs more cover than the vault supplies", () => {
    for (const v of vaults) for (const t of v.byToken) for (const l of t.depegUsd) expect(l).toBeLessThanOrEqual(v.supplyUsd + 0.01);
  });
});

describe("pricing", () => {
  it("prices at expected loss rate x (1 + risk load) + capital charge, flagging placeholder tokens", () => {
    for (const v of vaults.slice(0, 5)) {
      const p = priceVault(prep, cfg, v);
      expect(p.placeholder).toBe(p.tokens.some((t) => t.placeholder));
      expect(p.placeholderTokens).toEqual(p.tokens.filter((t) => t.placeholder).map((t) => t.symbol));
      const el = p.tokens.reduce((a, t) => a + t.annualProbability * t.lossUsd, 0);
      expect(p.expectedLossUsd).toBeCloseTo(el, 0);
      if (p.limitUsd > 0) expect(p.rate).toBeCloseTo((el / p.limitUsd) * (1 + cfg.pricing.riskLoad) + cfg.pricing.capitalCharge, 6);
      expect(p.limitUsd).toBe(Math.max(0, ...p.tokens.map((t) => t.lossUsd)));
    }
  });
});
