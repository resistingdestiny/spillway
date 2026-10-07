// One Morpho market as a picture: runs the lending engine in the browser on the published snapshot,
// and turns a markdown of the collateral into a scene. Shared by the landing page and the app.

import {
  type AdaptersFile,
  type LendingBundle,
  type PreparedMarket,
  type RawSnapshot,
  DEFAULT_CONFIG,
  loadBook,
  prepare,
  runScenario,
  thresholds,
} from "@spillway/lending";
import { layout } from "./layout.js";
import { load } from "./load.js";
import { renderOverlay, usdShort } from "./overlay.js";
import { COLORS, type Picture, type PictureLedge, type Scene } from "./picture.js";

export const SNAPSHOT = "data/lending/monad-2026-10-06.json";
const ADAPTERS = "data/lending/monad-2026-10-06.adapters.json";
const BUNDLE = "data/lending/bundle.json";
/** The mainnet market replayed on Monad testnet (contracts/deployments/monad-testnet-lending.json). */
export const REPLAYED_MARKET = "0x8bdb7d2c5024d349772884afb3c5c409bc8de58ed63d79618bf48fb57b595060";
/** Cover is sized to keep depositors whole up to this sudden fall. */
export const COVER_SHOCK = 0.25;
/** Ledge height, as a fall in the collateral price. */
const BUCKET = 0.005;

export type Prepared = ReturnType<typeof prepare>;
export type Fact = LendingBundle["markets"][number];
export type Price = LendingBundle["pricing"][number];

export interface Lending {
  bundle: LendingBundle;
  book: ReturnType<typeof loadBook>;
  prep: Prepared;
  facts: Map<string, Fact>;
  prices: Map<string | null, Price>;
  /** The largest markets by debt, largest first. */
  markets: PreparedMarket[];
}

export const pair = (pm: PreparedMarket): string => `${pm.market.collateral?.symbol ?? "?"}/${pm.market.loan.symbol}`;
export const pct = (x: number): string => `${(x * 100).toFixed(1).replace(/\.0$/, "")}%`;
/** A yearly cover rate, to two places below 1% so 0.71% does not read as 0.7%. */
export const rate = (x: number): string => (x < 0.01 ? `${(x * 100).toFixed(2)}%` : pct(x));
export const debtUsd = (pm: PreparedMarket): number => pm.borrowers.reduce((a, b) => a + b.debt, 0) * pm.loanUsd;

let loading: Promise<Lending> | null = null;

/** Load the snapshot and bundle and prepare the engine, once per page load. */
export function loadLending(): Promise<Lending> {
  const p = (loading ??= Promise.all([load<RawSnapshot>(SNAPSHOT), load<AdaptersFile>(ADAPTERS), load<LendingBundle>(BUNDLE)]).then(([raw, adapters, bundle]) => {
    const book = loadBook(raw, adapters);
    const prep = prepare(book, DEFAULT_CONFIG);
    const markets = prep.markets.filter((pm) => debtUsd(pm) > 1_000_000).sort((a, b) => debtUsd(b) - debtUsd(a)).slice(0, 6);
    return {
      bundle,
      book,
      prep,
      facts: new Map(bundle.markets.map((m) => [m.marketId, m] as const)),
      prices: new Map(bundle.pricing.map((p) => [p.name, p] as const)),
      markets,
    };
  }));
  p.catch(() => (loading = null));
  return p;
}

/**
 * Loss to suppliers when the collateral is marked down at once, with liquidators limited to what Monad's
 * exchanges can absorb inside their incentive (the thin exit). Split into written off and not.
 */
function lossAt(pm: PreparedMarket, prep: Prepared, shock: number) {
  const token = pm.market.collateral?.address ?? "";
  const run = runScenario(prep, DEFAULT_CONFIG, { kind: "thin", token, shock }).find((r) => r.marketId === pm.market.id);
  const byLedge = new Map<number, number>();
  if (!run) return { total: 0, unrealised: 0, byLedge };
  const value = new Map(pm.borrowers.map((b) => [b.user, b] as const));
  for (const p of run.positions) {
    const loss = (p.result.realised + p.result.unrealised) * pm.loanUsd;
    if (loss <= 0) continue;
    const b = value.get(p.user);
    if (!b) continue;
    const k = Math.floor(thresholds(b.debt, b.value, pm.market.lltv, pm.lif).liquidation / BUCKET);
    byLedge.set(k, (byLedge.get(k) ?? 0) + loss);
  }
  return { total: (run.realised + run.unrealised) * pm.loanUsd, unrealised: run.unrealised * pm.loanUsd, byLedge };
}

/** The largest named vault supplying the market, and its share. */
export function mainVault(pm: PreparedMarket): { name: string; share: number } {
  const byName = new Map<string, number>();
  for (const s of pm.suppliers) {
    const name = s.vaultName ?? "Other lenders";
    byName.set(name, (byName.get(name) ?? 0) + s.share);
  }
  const [name, share] = [...byName.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["Lenders", 1];
  return { name, share };
}

function ledges(pm: PreparedMarket, shock: number, losses: Map<number, number>): PictureLedge[] {
  const groups = new Map<number, number>();
  for (const b of pm.borrowers) {
    const k = Math.floor(thresholds(b.debt, b.value, pm.market.lltv, pm.lif).liquidation / BUCKET);
    groups.set(k, (groups.get(k) ?? 0) + b.debt * pm.loanUsd);
  }
  return [...groups.entries()].map(([k, dollars]) => ({
    ratio: 1 - (k + 0.5) * BUCKET,
    dollars,
    broken: shock >= k * BUCKET && shock > 0,
    water: losses.get(k) ?? 0,
  }));
}

export interface Moment {
  total: number;
  unrealised: number;
  coverPaid: number;
  depositors: number;
  marksDown: boolean;
}

/** Draw one market at one markdown into a picture, its overlay and its legend. */
export function drawMarket(d: Lending, pm: PreparedMarket, shock: number, picture: Picture, overlay: HTMLElement, legend: HTMLElement): Moment {
  const cover = Math.max(lossAt(pm, d.prep, COVER_SHOCK).total, 1);
  const { total, unrealised, byLedge } = lossAt(pm, d.prep, shock);
  const marksDown = d.facts.get(pm.market.id)?.shockMeans === "issuer marks down";
  const coverPaid = Math.min(total, cover);
  const depositors = total - coverPaid;
  const supply = pm.suppliers.reduce((a, s) => a + s.supplied, 0) * pm.loanUsd;
  const ls = ledges(pm, shock, byLedge);
  const scene: Scene = {
    ledges: ls,
    ghostRatio: shock > 0 ? 1 - shock : null,
    realRatio: null,
    water: total,
    bands: [
      { label: `Spillway cover (${usdShort(cover)}) pays`, tag: `Spillway cover ${usdShort(cover)}`, dollars: cover, paid: coverPaid, color: COLORS.accent },
      { label: `Depositors (${usdShort(supply)} supplied) lose`, tag: "Depositors", dollars: cover * 0.6, paid: depositors, color: COLORS.danger, wetOnly: true },
    ],
  };
  const { W, H } = picture.fit();
  const geo = layout(W, H, scene.bands.map((b) => b.dollars), Math.max(0, ...ls.map((l) => l.dollars)));
  picture.draw(geo, scene);
  const coll = pm.market.collateral?.symbol ?? "collateral";
  renderOverlay(overlay, geo, scene, {
    now: `${pair(pm)}, ${usdShort(debtUsd(pm))} borrowed`,
    ghost: (r) => `${coll} −${pct(1 - r)} at once`,
    tick: (mv) => `−${Math.round(mv * 100)}%`,
  }, legend);
  return { total, unrealised, coverPaid, depositors, marksDown };
}

/** The story of a market: today, the smallest markdown that costs depositors money, then 25%. */
export const storyOf = (d: Lending, pm: PreparedMarket): number[] => [0, d.facts.get(pm.market.id)?.firstLoss ?? 0.06, COVER_SHOCK];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

/** Plays a story by moving the markdown between its stops. A newer run or a stop ends the current one. */
export class Player {
  private run = 0;
  playing = false;
  readonly reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  /** `set` gets the markdown and the index of the last stop reached. */
  constructor(
    private get: () => number,
    private set: (shock: number, reached: number) => void,
  ) {}

  stop(): void {
    this.run++;
    this.playing = false;
  }

  /** Move through the stops once, or forever with `loop`. With reduced motion it jumps between stills. */
  async play(stops: number[], loop = false): Promise<void> {
    const run = ++this.run;
    this.playing = true;
    const live = () => run === this.run;
    do {
      this.set(stops[0] ?? 0, 0);
      await wait(2500);
      for (let i = 1; i < stops.length && live(); i++) {
        const to = stops[i] as number;
        const from = this.get();
        const t0 = performance.now();
        while (!this.reduced && live()) {
          const k = Math.min(1, (performance.now() - t0) / 2500);
          if (k >= 1) break;
          this.set(from + (to - from) * ease(k), i - 1);
          await new Promise((r) => requestAnimationFrame(r));
        }
        if (!live()) break;
        this.set(to, i);
        await wait(3500);
      }
    } while (loop && live());
    if (live()) this.playing = false;
  }
}
