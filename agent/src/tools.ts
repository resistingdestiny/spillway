// The tools the model may call. Each is a thin wrapper over @spillway/lending or the web app's
// testnet reader: it finds the market or vault asked for, calls the engine, and trims the result to
// what an answer needs. Dollars are rounded to the cent and shares to 0.01%.

import {
  type MarketRun,
  type PreparedMarket,
  type ScenarioKind,
  coverLimit,
  exitDepth,
  lossByVault,
  markedDown,
  runScenario,
  shockMeaning,
  shortfallWitness,
  usd,
} from "@spillway/lending";
import { formatUnits } from "viem";
import { type Engine, findMarket, findVault, pairOf } from "./engine.js";
import type { TestnetReader } from "./testnet.js";

export interface ToolOutcome {
  /** What the model reads, as JSON. */
  result: Record<string, unknown>;
  /** One short line for the reader, such as "Stressed wstETH/WETH at 20%". */
  summary: string;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema of the input. */
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<ToolOutcome>;
}

/** A tool input the model got wrong. Its message goes back to the model, so it can retry. */
export class ToolInputError extends Error {}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.trim() === "" || v.length > 120) throw new ToolInputError(`${key} must be a short string`);
  return v.trim();
}

function optInt(input: Record<string, unknown>, key: string, def: number, min: number, max: number): number {
  const v = input[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolInputError(`${key} must be a number`);
  return Math.max(min, Math.min(max, Math.round(v)));
}

/** A markdown in percent, 0 to 100, as a fraction. */
function markdown(input: Record<string, unknown>, key = "markdown_pct", def?: number): number {
  const v = input[key] ?? def;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) throw new ToolInputError(`${key} must be a percent from 0 to 100, so 20 for 20%`);
  return Math.round((v / 100) * 1e6) / 1e6;
}

function market(e: Engine, input: Record<string, unknown>): PreparedMarket {
  const q = str(input, "market");
  const pm = findMarket(e, q);
  if (!pm) throw new ToolInputError(`no market matches "${q}"; call list_markets for the pairs and ids`);
  return pm;
}

const marketDebtUsd = (pm: PreparedMarket) => pm.borrowers.reduce((a, b) => a + b.debt, 0) * pm.loanUsd;
const marketSupplyUsd = (pm: PreparedMarket) => pm.suppliers.reduce((a, s) => a + s.supplied, 0) * pm.loanUsd;

const SCENARIOS: Record<string, { kind: ScenarioKind; label: string }> = {
  thin_exit: { kind: "thin", label: "thin exit: liquidators sell only what Monad's exchanges absorb inside their incentive" },
  always_act: { kind: "depeg", label: "liquidators always act, with unlimited exit depth" },
  nobody_liquidates: { kind: "nobody", label: "nobody liquidates" },
  oracle_holds: { kind: "hidden", label: "the market price falls but the oracle holds, so nothing is liquidated" },
};

const marketSchema = { type: "string", description: 'A market id, a pair such as "wstETH/WETH", or a collateral symbol. A pair shared by several markets means the largest.' };
const markdownSchema = { type: "number", description: "The sudden fall of the collateral's oracle price, in percent, 0 to 100. 20 means 20%." };

export function makeTools(e: Engine, testnet: TestnetReader): Tool[] {
  const snapshot = { snapshotBlock: e.block, snapshotDate: e.date, chain: "Monad mainnet" };
  const withBorrowers = e.prep.markets.filter((pm) => pm.borrowers.length > 0);

  const listMarkets: Tool = {
    name: "list_markets",
    description:
      "Lists the Morpho markets on Monad with borrowers, largest debt first: pair, id, LLTV, borrowed and supplied in USD, the oracle kind and what a markdown means for it, and the exit depth liquidators have. Also gives totals and bad debt recorded so far.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "How many markets to list, 1 to 100. Default 10." },
        collateral: { type: "string", description: "Only markets taking this collateral symbol." },
        loan: { type: "string", description: "Only markets lending this loan symbol." },
      },
    },
    async run(input) {
      const limit = optInt(input, "limit", 10, 1, 100);
      const c = typeof input.collateral === "string" ? input.collateral.toLowerCase() : null;
      const l = typeof input.loan === "string" ? input.loan.toLowerCase() : null;
      const rows = e.markets
        .filter((m) => (c === null || m.collateral.symbol.toLowerCase() === c) && (l === null || m.loan.symbol.toLowerCase() === l))
        .sort((a, b) => b.debtUsd - a.debtUsd || (a.marketId < b.marketId ? -1 : 1));
      return {
        summary: `Listed ${Math.min(limit, rows.length)} of ${rows.length} markets`,
        result: {
          ...snapshot,
          marketsWithBorrowers: withBorrowers.length,
          totalBorrowedUsd: usd(e.markets.reduce((a, m) => a + m.debtUsd, 0)),
          totalSuppliedUsd: usd(e.prep.markets.reduce((a, pm) => a + marketSupplyUsd(pm), 0)),
          badDebtRecordedUsd: usd(e.book.markets.reduce((a, m) => a + m.badDebtUsd, 0)),
          matching: rows.length,
          markets: rows.slice(0, limit).map((m) => ({
            pair: `${m.collateral.symbol}/${m.loan.symbol}`,
            id: m.marketId,
            lltv: m.lltv,
            borrowedUsd: m.debtUsd,
            suppliedUsd: m.supplyUsd,
            borrowers: m.borrowers,
            oracleKind: m.oracleKind?.kind ?? "not read",
            markdownMeans: m.shockMeans ?? "oracle not read",
            exitDepthUsd: m.exit.depthUsd ?? "not measured",
          })),
        },
      };
    },
  };

  const stressMarket: Tool = {
    name: "stress_market",
    description:
      "Stresses one market: its collateral is marked down suddenly by the given percent, in every market that takes it at once. Returns the loss to suppliers in USD, how much is written off on chain (realised) and how much is not (unrealised), borrower outcomes, and the loss split by vault. The default scenario is the thin exit.",
    inputSchema: {
      type: "object",
      properties: {
        market: marketSchema,
        markdown_pct: markdownSchema,
        scenario: { type: "string", enum: Object.keys(SCENARIOS), description: "Default thin_exit, the headline." },
      },
      required: ["market", "markdown_pct"],
    },
    async run(input) {
      const pm = market(e, input);
      const shock = markdown(input);
      const name = typeof input.scenario === "string" && SCENARIOS[input.scenario] ? input.scenario : "thin_exit";
      const s = SCENARIOS[name] as (typeof SCENARIOS)[string];
      const token = pm.market.collateral as { address: string; symbol: string };
      const runs = runScenario(e.prep, e.cfg, { kind: s.kind, token: token.address, shock });
      const run = runs.find((r) => r.marketId === pm.market.id) as MarketRun;
      const lossUsd = (run.realised + run.unrealised) * pm.loanUsd;
      const split = [...lossByVault(lossUsd, pm.suppliers)].sort(([, a], [, b]) => b - a);
      const tokenLossUsd = runs.reduce((a, r) => {
        const m = e.prep.markets.find((x) => x.market.id === r.marketId) as PreparedMarket;
        return a + (r.realised + r.unrealised) * m.loanUsd;
      }, 0);
      const exit = exitDepth(token, pm.lif, e.cfg);
      return {
        summary: `Stressed ${pairOf(pm)} at ${pct(shock)}`,
        result: {
          ...snapshot,
          pair: pairOf(pm),
          marketId: pm.market.id,
          lltv: pm.market.lltv,
          markdown: pct(shock),
          scenario: s.label,
          markdownMeans: shockMeaning(pm.market.id, e.cfg) ?? "oracle not read",
          borrowedUsd: usd(marketDebtUsd(pm)),
          suppliedUsd: usd(marketSupplyUsd(pm)),
          exitDepthUsd: exit.depthUsd === null ? "not measured" : usd(exit.depthUsd),
          lossToSuppliersUsd: usd(lossUsd),
          writtenOffUsd: usd(run.realised * pm.loanUsd),
          notWrittenOffUsd: usd(run.unrealised * pm.loanUsd),
          liquidatableDebtUsd: usd(run.liquidatableDebt * pm.loanUsd),
          borrowers: run.outcomes,
          lossByVault: split.map(([v, l]) => ({ vault: v === null ? "other suppliers" : (e.book.vaults.get(v)?.name ?? v), lossUsd: usd(l), shareOfLoss: pct(lossUsd > 0 ? l / lossUsd : 0) })),
          sameTokenMarkets: runs.length,
          lossAcrossAllMarketsWithTokenUsd: usd(tokenLossUsd),
        },
      };
    },
  };

  const pmlRanking: Tool = {
    name: "pml_ranking",
    description:
      "Ranks collateral tokens by probable maximum loss: the loss to depositors across every Monad market that takes the token if it became worthless, in the thin exit. Also gives the loss at 5%, 10%, 25% and 50% markdowns and the smallest markdown that costs depositors anything.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", description: "How many tokens, 1 to 50. Default 5." } } },
    async run(input) {
      const limit = optInt(input, "limit", 5, 1, 50);
      return {
        summary: "Ranked collateral by maximum loss",
        result: {
          ...snapshot,
          tokens: e.pml.length,
          ranking: e.pml.slice(0, limit).map((r) => ({
            rank: r.rank,
            token: r.symbol,
            class: r.class,
            markets: r.markets,
            borrowedUsd: r.debtUsd,
            pmlUsd: r.pmlUsd,
            firstLossAtMarkdown: r.firstLoss === null ? "never" : pct(r.firstLoss),
            lossAtMarkdownUsd: Object.fromEntries(r.lossUsd.filter((x) => x.shock < 1).map((x) => [pct(x.shock), x.lossUsd])),
          })),
        },
      };
    },
  };

  const vaultCover: Tool = {
    name: "vault_cover",
    description:
      "One Morpho vault's exposure and the price Spillway would charge to cover its depositors: supply, the cover limit and the collateral token whose fall sets it, the yearly rate on the limit, the premium as a share of supply, expected yearly loss, and the loss to its depositors from each collateral token at a given markdown.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string", description: 'A vault name, whole or in part, such as "Steakhouse Prime ETH", or its address.' },
        markdown_pct: { type: "number", description: "Markdown for the per-token losses, in percent, whole numbers 0 to 100. Default 25." },
      },
      required: ["vault"],
    },
    async run(input) {
      const q = str(input, "vault");
      const v = findVault(e, q);
      if (!v) throw new ToolInputError(`no vault matches "${q}"; vaults include ${e.vaults.slice(0, 8).map((x) => x.name).join(", ")}`);
      const shock = Math.round(markdown(input, "markdown_pct", 25) * 100) / 100;
      const i = e.curves.shocks.indexOf(shock);
      const p = e.pricing.find((x) => x.vault === v.vault);
      if (!p) throw new Error(`vault ${v.vault} has no price`);
      const limitAt = coverLimit(v, e.curves.shocks, shock);
      return {
        summary: `Priced cover for ${v.name ?? v.vault}`,
        result: {
          ...snapshot,
          vault: v.name,
          address: v.vault,
          curators: v.curators,
          suppliedToMorphoUsd: v.supplyUsd,
          markets: v.markets,
          cover: {
            limitUsd: p.limitUsd,
            limitSetByToken: p.limitToken,
            ratePerYearOnLimit: pct(p.rate),
            rateTopOfRange: pct(p.rateHigh),
            annualPremiumUsd: p.annualPremiumUsd,
            premiumAsShareOfSupply: `${Math.round(p.premiumOnSupply * 1e4) / 100}%`,
            expectedYearlyLossUsd: p.expectedLossUsd,
            expectedYearlyLossRangeUsd: p.expectedLossRangeUsd,
            placeholderRateTokens: p.placeholderTokens,
            method: "Limit keeps depositors whole at each class's 90th percentile fall; rate = expected loss to the cover / limit x (1 + risk load) + capital charge.",
          },
          markdown: pct(shock),
          coverNeededAtMarkdownUsd: limitAt.limitUsd,
          worstTokenAtMarkdown: limitAt.symbol,
          lossByTokenAtMarkdown: v.byToken
            .map((t) => ({ token: t.symbol, class: t.class, lossUsd: t.lossUsd[i] ?? 0 }))
            .filter((t) => t.lossUsd > 0)
            .sort((a, b) => b.lossUsd - a.lossUsd)
            .slice(0, 8),
        },
      };
    },
  };

  const shortfallProof: Tool = {
    name: "shortfall_proof",
    description:
      "The shortfall anyone could prove from Morpho's positions if a market's oracle were marked down by the given percent and nobody liquidated: the sum of each borrower's debt beyond their collateral, and the borrowers to name in claimShortfall, in ascending order.",
    inputSchema: { type: "object", properties: { market: marketSchema, markdown_pct: markdownSchema }, required: ["market", "markdown_pct"] },
    async run(input) {
      const pm = market(e, input);
      const shock = markdown(input);
      const priceRaw = markedDown(pm.market.priceRaw as bigint, shock);
      const w = shortfallWitness(e.book, pm.market.id, priceRaw);
      const d = pm.market.loan.decimals;
      const shown = 20;
      return {
        summary: `Proved shortfall in ${pairOf(pm)} at ${pct(shock)}`,
        result: {
          ...snapshot,
          pair: pairOf(pm),
          marketId: pm.market.id,
          markdown: pct(shock),
          oraclePriceRaw: priceRaw.toString(),
          shortfallBaseUnits: w.shortfall.toString(),
          shortfall: `${formatUnits(w.shortfall, d)} ${pm.market.loan.symbol}`,
          shortfallUsd: usd((Number(w.shortfall) / 10 ** d) * pm.loanUsd),
          borrowersToName: w.borrowers.length,
          borrowersOfMarket: pm.borrowers.length,
          borrowers: w.borrowers.slice(0, shown).map((b) => b.user),
          listTruncated: w.borrowers.length > shown,
        },
      };
    },
  };

  const testnetCover: Tool = {
    name: "testnet_cover",
    description:
      "Reads the live cover on Monad testnet now: the cover vault's free capital and total paid out, policy 1's limit and what it has been paid so far, what it could claim now, and the last claim with its transaction. The testnet market replays the wstETH/WETH book at 1% scale, in tUSD test dollars.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const c = await testnet();
      return { summary: `Read the testnet cover at block ${c.block.toLocaleString("en-US")}`, result: { ...c } };
    },
  };

  return [listMarkets, stressMarket, pmlRanking, vaultCover, shortfallProof, testnetCover];
}
