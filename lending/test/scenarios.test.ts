import { describe, expect, it } from "vitest";
import { lossByVault, splitLoss } from "../src/attribution.js";
import { DEFAULT_CONFIG, type LendingConfig } from "../src/config.js";
import { exitDepth } from "../src/exit.js";
import { type ScenarioKind, prepare, runScenario } from "../src/scenarios.js";
import { monadBook } from "./fixture.js";

const cfg = DEFAULT_CONFIG;
const prep = prepare(monadBook(), cfg);
const tokens = [...prep.byToken.keys()];
const bySymbol = (symbol: string) => tokens.find((t) => prep.byToken.get(t)?.[0]?.market.collateral?.symbol === symbol) as string;
const total = (kind: ScenarioKind, token: string, shock: number, c: LendingConfig = cfg) =>
  runScenario(prep, c, { kind, token, shock }).reduce((a, r) => ({ realised: a.realised + r.realised, unrealised: a.unrealised + r.unrealised }), { realised: 0, unrealised: 0 });

describe("scenarios on the 6 October book", () => {
  it("shock one token in every market that takes it, and no other", () => {
    const wsteth = bySymbol("wstETH");
    const runs = runScenario(prep, cfg, { kind: "depeg", token: wsteth, shock: 0.1 });
    expect(runs.length).toBe(6);
    for (const r of runs) expect(prep.book.markets.find((m) => m.id === r.marketId)?.collateral?.address).toBe(wsteth);
  });

  it("a 100% depeg writes off every borrower's whole debt", () => {
    for (const t of tokens) {
      const runs = runScenario(prep, cfg, { kind: "depeg", token: t, shock: 1 });
      for (const r of runs) {
        const debt = r.positions.reduce((a, p) => a + p.debt, 0);
        expect(r.realised).toBeCloseTo(debt, 6);
        expect(r.unrealised).toBe(0);
      }
    }
  });

  it("losses only grow as the depeg deepens", () => {
    for (const t of tokens) {
      let last = 0;
      for (const shock of cfg.shockGrid) {
        const { realised, unrealised } = total("depeg", t, shock);
        expect(realised + unrealised).toBeGreaterThanOrEqual(last - 1e-9);
        last = realised + unrealised;
      }
    }
  });

  it("hidden loss liquidates nothing new and leaves the loss unrealised", () => {
    const pt = bySymbol("PT-USDat-14JAN2027");
    const runs = runScenario(prep, cfg, { kind: "hidden", token: pt, shock: 0.5 });
    const base = runScenario(prep, cfg, { kind: "depeg", token: pt, shock: 0 });
    expect(runs.map((r) => r.liquidatableDebt)).toEqual(base.map((r) => r.liquidatableDebt));
    expect(runs.reduce((a, r) => a + r.realised, 0)).toBe(0);
    expect(runs.reduce((a, r) => a + r.unrealised, 0)).toBeGreaterThan(0);
  });

  it("thin exit with unlimited depth is the depeg, and with no depth is nobody liquidating", () => {
    const t = bySymbol("aHYPER");
    const open: LendingConfig = { ...cfg, thinExit: { quotes: {}, exitDepthUsd: {} } };
    expect(total("thin", t, 0.3, open)).toEqual(total("depeg", t, 0.3));
    const dry: LendingConfig = { ...cfg, thinExit: { quotes: {}, exitDepthUsd: { [t]: 0 } } };
    const runs = runScenario(prep, dry, { kind: "thin", token: t, shock: 0.3 });
    for (const r of runs) {
      expect(r.realised).toBe(0);
      for (const p of r.positions) {
        const b = prep.byToken.get(t)?.flatMap((pm) => pm.borrowers).find((x) => x.user === p.user && p.debt === x.debt);
        expect(p.result.unrealised).toBeCloseTo(Math.max(0, p.debt - (b?.value ?? 0) * 0.7), 9);
      }
    }
  });

  it("thin exit with zero depth equals nobody liquidating, for every token and fall", () => {
    const dry: LendingConfig = { ...cfg, thinExit: { quotes: {}, exitDepthUsd: Object.fromEntries(tokens.map((t) => [t, 0])) } };
    for (const t of tokens) {
      for (const shock of cfg.reportShocks) {
        const thin = runScenario(prep, dry, { kind: "thin", token: t, shock });
        const nobody = runScenario(prep, cfg, { kind: "nobody", token: t, shock });
        expect(thin).toEqual(nobody);
        for (const r of nobody) expect(r.realised).toBe(0);
      }
    }
  });

  it("thin exit on the research's quotes: no route means nobody liquidates", () => {
    // strUSD has no route at any size, so its thin exit is nobody liquidating.
    const t = bySymbol("strUSD");
    for (const shock of [0.1, 0.25, 0.5]) expect(total("thin", t, shock)).toEqual(total("nobody", t, shock));
  });

  it("thin exit sells no more than the deepest market's depth, most unhealthy first", () => {
    const t = bySymbol("wstETH");
    const pms = prep.byToken.get(t) ?? [];
    const depth = Math.max(...pms.map((pm) => exitDepth(pm.market.collateral as { address: string; symbol: string }, pm.lif, cfg).depthUsd ?? 0));
    expect(depth).toBeGreaterThan(0);
    for (const shock of [0.1, 0.3, 0.6]) {
      const runs = runScenario(prep, cfg, { kind: "thin", token: t, shock });
      let sold = 0;
      for (const r of runs) {
        const pm = pms.find((m) => m.market.id === r.marketId) as (typeof pms)[number];
        // Within one market every position has the same depth: once one gets nothing, no less healthy one gets anything.
        const filled: { hf: number; seized: number }[] = [];
        for (const p of r.positions) {
          sold += p.result.seized * pm.loanUsd;
          const b = pm.borrowers.find((x) => x.user === p.user) as { healthFactor: number };
          if (p.result.liquidatable) filled.push({ hf: b.healthFactor, seized: p.result.seized });
        }
        filled.sort((a, b) => a.hf - b.hf);
        const firstEmpty = filled.findIndex((f) => f.seized === 0);
        if (firstEmpty >= 0) for (const f of filled.slice(firstEmpty + 1)) expect(f.seized).toBe(0);
      }
      expect(sold).toBeLessThanOrEqual(depth + 1e-6);
    }
  });

  it("thin exit leaves part of the loss unrealised, between nobody liquidating and the full depeg", () => {
    // An unrealised shortfall is debt - value. A liquidation that runs out of collateral writes off
    // debt - value / LIF: the incentive paid to liquidators comes out of suppliers' pockets. So a thin
    // exit moves loss from realised to unrealised and its total sits between the two.
    const t = bySymbol("aHYPER");
    const some: LendingConfig = { ...cfg, thinExit: { quotes: {}, exitDepthUsd: { [t]: 1_000_000 } } };
    const dry: LendingConfig = { ...cfg, thinExit: { quotes: {}, exitDepthUsd: { [t]: 0 } } };
    for (const shock of [0.25, 0.3, 0.5]) {
      const thin = total("thin", t, shock, some);
      const depeg = total("depeg", t, shock);
      const nobody = total("thin", t, shock, dry);
      expect(thin.realised).toBeLessThan(depeg.realised);
      expect(thin.unrealised).toBeGreaterThan(0);
      expect(thin.realised + thin.unrealised).toBeLessThanOrEqual(depeg.realised + depeg.unrealised + 1e-6);
      expect(thin.realised + thin.unrealised).toBeGreaterThanOrEqual(nobody.unrealised - 1e-6);
    }
  });
});

describe("conservation", () => {
  it("each market's bad debt equals the sum of its suppliers' losses, in every scenario", () => {
    for (const kind of ["depeg", "hidden"] as const) {
      for (const t of tokens) {
        for (const shock of cfg.reportShocks) {
          for (const r of runScenario(prep, cfg, { kind, token: t, shock })) {
            const pm = prep.markets.find((m) => m.market.id === r.marketId);
            const suppliers = pm?.suppliers ?? [];
            const loss = r.realised + r.unrealised;
            if (suppliers.length === 0) {
              expect(loss).toBe(0);
              continue;
            }
            const split = splitLoss(loss, suppliers).reduce((a, s) => a + s.loss, 0);
            expect(Math.abs(split - loss)).toBeLessThanOrEqual(1e-9 * Math.max(1, loss));
            const byVault = [...lossByVault(loss, suppliers).values()].reduce((a, v) => a + v, 0);
            expect(Math.abs(byVault - loss)).toBeLessThanOrEqual(1e-9 * Math.max(1, loss));
          }
        }
      }
    }
  });

  it("supply shares add up to the whole market", () => {
    for (const pm of prep.markets) {
      if (pm.suppliers.length === 0) continue;
      expect(pm.suppliers.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 12);
    }
  });
});
