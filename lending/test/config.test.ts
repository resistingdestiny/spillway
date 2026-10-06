import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type CollateralClass, DEFAULT_CONFIG as cfg, severityQuantile, shockMeaning, tokenRate } from "../src/config.js";
import { monadBook } from "./fixture.js";

const research = JSON.parse(readFileSync(new URL("../../research/research-config.json", import.meta.url), "utf8"));
const book = monadBook();
const collateral = [...new Map(book.markets.flatMap((m) => (m.collateral ? [[m.collateral.address, m.collateral] as const] : []))).values()];
const borrowed = new Set(book.positions.filter((p) => p.borrowAssets > 0n).map((p) => p.marketId));
const withBorrowers = collateral.filter((c) => book.markets.some((m) => m.collateral?.address === c.address && borrowed.has(m.id)));

describe("failure classes", () => {
  it("take the research's probability and 90% range", () => {
    const f = research.failure_frequency;
    const pairs: [CollateralClass, { p_annual: number; p_annual_90ci: number[] }][] = [
      ["synthetic-dollar", f.synthetic_dollar],
      ["managed-strategy", research.failure_frequency_alt.synthetic_dollar_narrow],
      ["lst-lrt", f.lst_lrt],
      ["rwa-credit", f.rwa_credit],
      ["wrapped-btc", f.wrapped_btc],
    ];
    for (const [cls, r] of pairs) {
      const c = cfg.pricing.classes[cls];
      expect(c.placeholder).toBe(false);
      expect(c.source).toContain("docs/RESEARCH.md");
      expect(c.annualProbability).toBe(r.p_annual);
      expect(c.range).toEqual(r.p_annual_90ci);
    }
    expect(cfg.pricing.ptTerm.annualProbability).toBe(f.pendle_pt_specific.p_annual_upper95);
  });

  it("draw their severities from the research's incidents", () => {
    const falls = new Map<string, number>();
    for (const list of Object.values(research.incidents) as { source?: string; low_vs_pre?: number | null }[][]) {
      for (const i of list) if (i.source && typeof i.low_vs_pre === "number") falls.set(i.source, -i.low_vs_pre);
    }
    for (const c of Object.values(cfg.pricing.classes)) {
      if (c.placeholder) continue;
      expect(c.incidents.length).toBeGreaterThan(0);
      for (const i of c.incidents) {
        expect(i.fall).toBeGreaterThan(0);
        expect(i.fall).toBeLessThanOrEqual(1);
        // Every fall is the research's figure, except Elixir's, which is taken as total.
        if (falls.has(i.source)) expect(i.fall).toBe(falls.get(i.source));
        else expect(i.token).toContain("Elixir");
      }
    }
  });

  it("give the 90th percentile between the sorted incidents", () => {
    const c = cfg.pricing.classes["synthetic-dollar"];
    // Sorted: 0.246, 0.77, 0.9149, 0.9901, 0.9935, 1. The 0.9 quantile sits halfway from 0.9935 to 1.
    expect(severityQuantile(c, 0.9)).toBeCloseTo(0.99675, 9);
    expect(severityQuantile(c, 0)).toBe(0.246);
    expect(severityQuantile(c, 1)).toBe(1);
    expect(severityQuantile(cfg.pricing.classes["lst-lrt"], 0.9)).toBe(0.2007);
  });
});

describe("token classes", () => {
  it("give every collateral token on the snapshot a class and a reason", () => {
    for (const c of collateral) {
      const tc = cfg.pricing.tokenClass[c.symbol];
      expect(tc, c.symbol).toBeDefined();
      expect(tc?.reason.length).toBeGreaterThan(10);
    }
  });

  it("source every token with borrowers, apart from the ones the research does not cover", () => {
    const unresearched = withBorrowers.filter((c) => tokenRate(c.symbol, cfg).placeholder).map((c) => c.symbol);
    // Bridged majors, Monad's own coin, tokenised gold and test tokens with no USD price.
    for (const s of unresearched) expect(["WETH", "SOL", "WMON", "XAUt0", "TETH", "testwstETH"]).toContain(s);
    const priced = withBorrowers.filter((c) => c.priceUsd !== null && !["WETH", "SOL", "WMON", "XAUt0"].includes(c.symbol));
    for (const c of priced) expect(tokenRate(c.symbol, cfg).placeholder, c.symbol).toBe(false);
  });

  it("price a PT as its underlying's class plus the PT-specific term", () => {
    for (const c of collateral.filter((c) => c.symbol.startsWith("PT-"))) {
      const r = tokenRate(c.symbol, cfg);
      expect(r.pt).toBe(true);
      const base = cfg.pricing.classes[r.class];
      expect(r.annualProbability).toBeCloseTo(base.annualProbability + cfg.pricing.ptTerm.annualProbability, 12);
      expect(r.range[1]).toBeCloseTo(base.range[1] + cfg.pricing.ptTerm.annualProbability, 12);
      expect(r.incidents).toEqual(base.incidents);
    }
    expect(tokenRate("wstETH", cfg).pt).toBe(false);
  });
});

describe("oracle kinds", () => {
  const kinds: Record<string, string> = {
    exchange_rate: "exchange-rate",
    exchange_rate_over_market_quote: "exchange-rate",
    vault_share_price: "vault-share-price",
    vault_share_price_operator_reported: "vault-share-price",
    issuer_nav_push: "issuer-nav",
    market_price_twap_pt_vs_underlying: "pt-twap",
  };

  it("cover the eight researched markets, as the research read them", () => {
    expect(Object.keys(cfg.oracles)).toHaveLength(8);
    for (const o of research.oracles as { marketId: string; market: string; kind: string; depeg_triggers_liquidation: boolean | string; assumed_fixed: string[] }[]) {
      const ours = cfg.oracles[o.marketId.toLowerCase()];
      expect(ours, o.market).toBeDefined();
      expect(ours?.pair).toBe(o.market);
      expect(ours?.kind).toBe(kinds[o.kind]);
      expect(ours?.assumedFixed).toEqual(o.assumed_fixed);
      // The research marks PTs as "PT selloff yes, underlying depeg no".
      if (typeof o.depeg_triggers_liquidation === "boolean") expect(ours?.depegReachesOracle).toBe(o.depeg_triggers_liquidation);
      else expect(ours).toMatchObject({ kind: "pt-twap", depegReachesOracle: true, underlyingDepegReachesOracle: false });
      expect(book.markets.some((m) => m.id === o.marketId.toLowerCase())).toBe(true);
    }
  });

  it("say what a market's shock means", () => {
    const meaning = (pair: string) => {
      const id = Object.entries(cfg.oracles).find(([, o]) => o.pair === pair)?.[0] as string;
      return shockMeaning(id, cfg);
    };
    expect(meaning("wstETH/WETH")).toBe("issuer marks down");
    expect(meaning("aHYPER/USDC")).toBe("issuer marks down");
    expect(meaning("PT-USDat-14JAN2027/USDC")).toBe("market price falls");
    expect(Object.values(cfg.oracles).filter((o) => !o.depegReachesOracle)).toHaveLength(6);
    expect(shockMeaning("0xnot-read", cfg)).toBeNull();
  });
});
