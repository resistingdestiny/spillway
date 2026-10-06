// Monad lending: for one Morpho market, what would have to break for depositors to lose money, and
// what Spillway's cover would pay. Runs the lending engine in the browser on the published snapshot.

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
import { layout } from "../layout.js";
import { load } from "../load.js";
import { renderOverlay, usd, usdShort } from "../overlay.js";
import { COLORS, Picture, type PictureLedge, type Scene } from "../picture.js";

const SNAPSHOT = "data/lending/monad-2026-10-06.json";
const ADAPTERS = "data/lending/monad-2026-10-06.adapters.json";
const BUNDLE = "data/lending/bundle.json";
/** The mainnet market replayed on Monad testnet (contracts/deployments/monad-testnet-lending.json). */
const REPLAYED_MARKET = "0x8bdb7d2c5024d349772884afb3c5c409bc8de58ed63d79618bf48fb57b595060";
/** Cover is sized to keep depositors whole up to this sudden fall. */
const COVER_SHOCK = 0.25;
/** Ledge height, as a fall in the collateral price. */
const BUCKET = 0.005;

const VIEW = `
  <div class="market" id="lend-sub"></div>
  <p class="headline" id="lend-headline"></p>
  <div class="chips" id="lend-markets" role="group" aria-label="Market"></div>
  <section class="stage" id="lend-stage" aria-label="The flood picture">
    <div class="canvas" id="lend-canvas"></div>
    <div class="overlay" id="lend-overlay"></div>
  </section>
  <p class="sentence" id="lend-sentence"></p>
  <section class="controls">
    <label class="slider" for="lend-shock">
      <span class="slider-label"><span id="lend-shock-what">Collateral falls at once by</span> <b id="lend-shock-value">0%</b></span>
      <input type="range" id="lend-shock" min="0" max="40" step="0.5" value="0" />
    </label>
    <div class="play-row">
      <button id="lend-play" class="play">Play</button>
      <a id="lend-proof" href="#/cover" hidden>See a 25% markdown paid on Monad testnet</a>
    </div>
  </section>`;

/** What each kind of oracle reads, in words. */
const ORACLE_READS: Record<string, string> = {
  "exchange-rate": "an exchange rate",
  "vault-share-price": "a vault's own share price",
  "issuer-nav": "the issuer's reported value",
  "pt-twap": "a time-weighted market price",
};

const pair = (pm: PreparedMarket) => `${pm.market.collateral?.symbol ?? "?"}/${pm.market.loan.symbol}`;
const pct = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, "")}%`;

/**
 * Loss to suppliers when the collateral is marked down at once, with liquidators limited to what Monad's
 * exchanges can absorb inside their incentive (the thin exit). Split into written off and not.
 */
function lossAt(pm: PreparedMarket, prep: ReturnType<typeof prepare>, shock: number) {
  const token = pm.market.collateral?.address ?? "";
  const run = runScenario(prep, DEFAULT_CONFIG, { kind: "thin", token, shock }).find((r) => r.marketId === pm.market.id);
  const byLedge = new Map<number, number>();
  if (!run) return { total: 0, realised: 0, unrealised: 0, byLedge };
  const value = new Map(pm.borrowers.map((b) => [b.user, b] as const));
  for (const p of run.positions) {
    const loss = (p.result.realised + p.result.unrealised) * pm.loanUsd;
    if (loss <= 0) continue;
    const b = value.get(p.user);
    if (!b) continue;
    const k = Math.floor(thresholds(b.debt, b.value, pm.market.lltv, pm.lif).liquidation / BUCKET);
    byLedge.set(k, (byLedge.get(k) ?? 0) + loss);
  }
  return { total: (run.realised + run.unrealised) * pm.loanUsd, realised: run.realised * pm.loanUsd, unrealised: run.unrealised * pm.loanUsd, byLedge };
}

/** The largest named vault supplying the market, and its share. */
function mainVault(pm: PreparedMarket): { name: string; share: number } {
  const byName = new Map<string, number>();
  for (const s of pm.suppliers) {
    const name = s.vaultName ?? "Other lenders";
    byName.set(name, (byName.get(name) ?? 0) + s.share);
  }
  const [name, share] = [...byName.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["Lenders", 1];
  return { name, share };
}

export async function mountLending(root: HTMLElement): Promise<() => void> {
  root.innerHTML = VIEW;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;

  const [raw, adapters, bundle] = await Promise.all([load<RawSnapshot>(SNAPSHOT), load<AdaptersFile>(ADAPTERS), load<LendingBundle>(BUNDLE)]);
  const facts = new Map(bundle.markets.map((m) => [m.marketId, m] as const));
  const prices = new Map(bundle.pricing.map((p) => [p.name, p] as const));
  const book = loadBook(raw, adapters);
  const prep = prepare(book, DEFAULT_CONFIG);
  const debtUsd = (pm: PreparedMarket) => pm.borrowers.reduce((a, b) => a + b.debt, 0) * pm.loanUsd;
  const markets = prep.markets.filter((pm) => debtUsd(pm) > 1_000_000).sort((a, b) => debtUsd(b) - debtUsd(a)).slice(0, 6);
  const totalDebt = prep.markets.reduce((a, pm) => a + debtUsd(pm), 0);
  const borrowed = prep.markets.filter((pm) => pm.borrowers.length > 0).length;

  let current = markets[0] as PreparedMarket;
  let shock = 0;

  $("lend-markets").innerHTML = markets
    .map((pm, i) => `<button data-i="${i}" aria-pressed="${i === 0}">${pair(pm)}</button>`)
    .join("");
  $("lend-sub").textContent = `Morpho on Monad, block ${book.blocks.to.number.toLocaleString("en-US")}`;

  const picture = new Picture();
  await picture.mount($("lend-canvas"));

  function ledges(pm: PreparedMarket, losses: Map<number, number>): PictureLedge[] {
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

  function draw(): void {
    const pm = current;
    const cover = Math.max(lossAt(pm, prep, COVER_SHOCK).total, 1);
    const { total, unrealised, byLedge } = lossAt(pm, prep, shock);
    const fact = facts.get(pm.market.id);
    const marksDown = fact?.shockMeans === "issuer marks down";
    const coverPaid = Math.min(total, cover);
    const depositors = total - coverPaid;
    const vault = mainVault(pm);
    const supply = pm.suppliers.reduce((a, s) => a + s.supplied, 0) * pm.loanUsd;
    const ls = ledges(pm, byLedge);
    const scene: Scene = {
      ledges: ls,
      ghostRatio: shock > 0 ? 1 - shock : null,
      realRatio: null,
      water: total,
      bands: [
        { label: `Spillway cover (${usdShort(cover)}) pays`, dollars: cover, paid: coverPaid, color: COLORS.accent },
        { label: `Depositors (${usdShort(supply)} supplied) lose`, dollars: cover * 0.6, paid: depositors, color: COLORS.danger, wetOnly: true },
      ],
    };
    const { W, H } = picture.fit();
    const geo = layout(W, H, scene.bands.map((b) => b.dollars), Math.max(0, ...ls.map((l) => l.dollars)));
    picture.draw(geo, scene);
    const coll = pm.market.collateral?.symbol ?? "collateral";
    renderOverlay($("lend-overlay"), geo, scene, {
      now: `${pair(pm)}, ${usdShort(debtUsd(pm))} borrowed`,
      ghost: (r) => `${coll} −${pct(1 - r)} at once`,
      tick: (mv) => `−${Math.round(mv * 100)}%`,
    });

    // First loss under the thin exit, as published in the bundle.
    const firstLoss = fact?.firstLoss ?? null;
    const price = prices.get(vault.name);
    const depth = fact?.exit?.depthUsd;
    const what = marksDown ? `${coll} marked down at once by` : `${coll} falls at once by`;
    $("lend-shock-what").textContent = what;
    $("lend-headline").innerHTML =
      shock <= 0
        ? `In ${pair(pm)}, ${firstLoss === null ? "no sudden fall up to 100% costs depositors anything" : `a sudden <b>${pct(firstLoss)}</b> ${marksDown ? "markdown" : "fall"} of ${coll} is the smallest that costs depositors money`}.` +
          (price ? ` Cover for ${vault.name}'s depositors costs <b>${pct(price.premiumOnSupply)}</b> of supply a year.` : "")
        : `A ${pct(shock)} ${marksDown ? "markdown" : "fall"} of ${coll} leaves <b>${usdShort(total)}</b> unpaid. ${vault.name} supplies ${pct(vault.share)} of this market.`;
    const oracleNote = fact?.oracleKind && !fact.oracleKind.depegReachesOracle ? ` Its oracle reads ${ORACLE_READS[fact.oracleKind.kind] ?? "a reported figure"}, so a market sell-off alone would not move it.` : "";
    $("lend-sentence").textContent =
      shock <= 0
        ? `Each ledge is borrowing liquidated if ${coll} is ${marksDown ? "marked down" : "falls"} that far.${oracleNote}`
        : total <= 0
          ? "Every position's collateral still covers its debt, so depositors lose nothing."
          : `${depth !== undefined && depth !== null ? `Liquidators can sell only ${usdShort(depth)} of ${coll} on Monad inside their incentive, so ${usdShort(unrealised)} is never written off. ` : ""}${depositors <= 0 ? `Spillway proves the shortfall from Morpho's positions and pays all ${usdShort(total)}.` : `Spillway pays ${usdShort(coverPaid)} and depositors lose ${usdShort(depositors)}.`}`;
    $("lend-shock-value").textContent = pct(shock);
    // The replay on testnet is of this market.
    ($("lend-proof") as HTMLAnchorElement).hidden = pm.market.id !== REPLAYED_MARKET;
  }

  // ---------------------------------------------------------------- play: the story in one go
  // Today, then the smallest markdown that costs depositors money, then 25%, where liquidators can
  // not sell and the cover pays. With reduced motion it jumps between those stills.
  let playing = 0;
  let active = false;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  function setShock(x: number): void {
    shock = Math.round(x * 2000) / 2000;
    ($("lend-shock") as HTMLInputElement).value = String(shock * 100);
    draw();
  }
  function stop(): void {
    playing++;
    active = false;
    $("lend-play").textContent = "Play";
  }
  async function play(): Promise<void> {
    const run = ++playing;
    active = true;
    $("lend-play").textContent = "Stop";
    const first = facts.get(current.market.id)?.firstLoss ?? 0.06;
    const stops = [0, first, 0.25];
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    setShock(0);
    await wait(2500);
    for (const to of stops.slice(1)) {
      if (run !== playing) return;
      const from = shock;
      const ms = reduced ? 0 : 2500;
      const t0 = performance.now();
      while (!reduced && run === playing) {
        const k = Math.min(1, (performance.now() - t0) / ms);
        setShock(from + (to - from) * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2));
        if (k >= 1) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (run !== playing) return;
      setShock(to);
      await wait(3500);
    }
    if (run === playing) stop();
  }
  $("lend-play").addEventListener("click", () => (active ? stop() : void play()));

  const onShock = (e: Event) => {
    stop();
    shock = Number((e.target as HTMLInputElement).value) / 100;
    draw();
  };
  const onMarket = (e: Event) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    stop();
    current = markets[Number(b.dataset.i)] as PreparedMarket;
    root.querySelectorAll<HTMLButtonElement>("#lend-markets button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    draw();
  };
  $("lend-shock").addEventListener("input", onShock);
  $("lend-markets").addEventListener("click", onMarket);
  const resize = new ResizeObserver(() => requestAnimationFrame(draw));
  resize.observe($("lend-stage"));
  draw();
  return () => {
    stop();
    resize.disconnect();
    picture.destroy();
  };
}
