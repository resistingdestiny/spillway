// Monad lending: for one Morpho market, what would have to break for depositors to lose money, and
// what Spillway's cover would pay. Runs the lending engine in the browser on the published snapshot.

import {
  type AdaptersFile,
  type PreparedMarket,
  type RawSnapshot,
  DEFAULT_CONFIG,
  loadBook,
  positionOutcome,
  prepare,
  thresholds,
} from "@spillway/lending";
import { layout } from "../layout.js";
import { load } from "../load.js";
import { renderOverlay, usd, usdShort } from "../overlay.js";
import { COLORS, Picture, type PictureLedge, type Scene } from "../picture.js";

const SNAPSHOT = "data/lending/monad-2026-10-06.json";
const ADAPTERS = "data/lending/monad-2026-10-06.adapters.json";
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
      <span class="slider-label">Collateral falls at once by <b id="lend-shock-value">0%</b></span>
      <input type="range" id="lend-shock" min="0" max="40" step="0.5" value="0" />
    </label>
  </section>`;

const pair = (pm: PreparedMarket) => `${pm.market.collateral?.symbol ?? "?"}/${pm.market.loan.symbol}`;
const pct = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, "")}%`;

/** Loss to suppliers at a sudden fall, in USD, with the oracle following the price. */
function lossAt(pm: PreparedMarket, shock: number): { total: number; byLedge: Map<number, number> } {
  const byLedge = new Map<number, number>();
  let total = 0;
  for (const b of pm.borrowers) {
    const value = b.value * (1 - shock);
    const r = positionOutcome({ debt: b.debt, oracleValue: value, marketValue: value, lltv: pm.market.lltv, lif: pm.lif, fill: 1 });
    const loss = (r.realised + r.unrealised) * pm.loanUsd;
    if (loss <= 0) continue;
    total += loss;
    const k = Math.floor(thresholds(b.debt, b.value, pm.market.lltv, pm.lif).liquidation / BUCKET);
    byLedge.set(k, (byLedge.get(k) ?? 0) + loss);
  }
  return { total, byLedge };
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

  const [raw, adapters] = await Promise.all([load<RawSnapshot>(SNAPSHOT), load<AdaptersFile>(ADAPTERS)]);
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
    const cover = Math.max(lossAt(pm, COVER_SHOCK).total, 1);
    const { total, byLedge } = lossAt(pm, shock);
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

    const first = pm.borrowers.map((b) => thresholds(b.debt, b.value, pm.market.lltv, pm.lif).badDebt).filter((x) => x > 0);
    const firstLoss = first.length ? Math.min(...first) : null;
    $("lend-headline").innerHTML =
      shock <= 0
        ? `<b>${usdShort(totalDebt)}</b> is borrowed across ${borrowed} Morpho markets on Monad. In ${pair(pm)}, ${firstLoss === null ? "no sudden fall up to 100% costs depositors anything" : `a sudden <b>${pct(firstLoss)}</b> fall in ${coll} is the smallest that costs depositors money`}.`
        : `A sudden ${pct(shock)} fall in ${coll} leaves <b>${usdShort(total)}</b> unpaid. ${vault.name} supplies ${pct(vault.share)} of this market.`;
    $("lend-sentence").textContent =
      shock <= 0
        ? "Each ledge is borrowing that gets liquidated if the collateral falls that far. Water is debt the collateral can not repay."
        : total <= 0
          ? `Liquidators can sell every position's collateral for more than its debt, so depositors lose nothing.`
          : depositors <= 0
            ? `Spillway's cover pays all ${usd(total)}, and depositors are made whole.`
            : `Spillway's cover pays ${usd(coverPaid)} and depositors lose the other ${usd(depositors)}.`;
    $("lend-shock-value").textContent = pct(shock);
  }

  const onShock = (e: Event) => {
    shock = Number((e.target as HTMLInputElement).value) / 100;
    draw();
  };
  const onMarket = (e: Event) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
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
    resize.disconnect();
    picture.destroy();
  };
}
