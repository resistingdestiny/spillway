// The app: one Morpho market at a time as a picture, its markdown slider, and the cover for it.
// The testnet proof and the Verify facts open in a drawer, at #/app/proof and #/app/verify.

import type { PreparedMarket } from "@spillway/lending";
import { mountAsk } from "../agent/widget.js";
import { type Lending, Player, REPLAYED_MARKET, debtUsd, drawMarket, loadLending, mainVault, pair, pct, rate, storyOf } from "../market.js";
import { usdShort } from "../overlay.js";
import { Picture } from "../picture.js";
import { onCopy, verifyFacts } from "./verify.js";

const PLAY = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8v8.4a.6.6 0 0 0 .9.5l6.6-4.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>Play`;
const STOP = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor"/></svg>Stop`;
const CLOSE = `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

const DRAWERS = {
  proof: "Paid on Monad testnet",
  verify: "Rerun every number",
} as const;
type Drawer = keyof typeof DRAWERS;

/** What each kind of oracle reads, in words. */
const ORACLE_READS: Record<string, string> = {
  "exchange-rate": "an exchange rate",
  "vault-share-price": "a vault's own share price",
  "issuer-nav": "the issuer's reported value",
  "pt-twap": "a time-weighted market price",
};

const stat = (k: string, v: string, sub: string, cls = "") => `<div class="stat ${cls}"><span class="k">${k}</span><span class="v">${v}</span><span class="sub">${sub}</span></div>`;
const skeletonStat = (k: string) => stat(k, `<span class="skeleton"></span>`, "&nbsp;");

const VIEW = `
  <div class="studio">
    <div class="chips" id="app-markets" role="group" aria-label="Market"><span class="skeleton" style="width:60%;height:32px;border-radius:999px"></span></div>
    <div class="studio-head">
      <div class="overline" id="app-sub"><span class="skeleton" style="width:220px"></span></div>
      <h1 class="headline" id="app-headline"><span class="skeleton" style="width:80%"></span></h1>
      <div class="stats" id="app-stats" aria-live="polite">${skeletonStat("Borrowed")}${skeletonStat("First loss at")}</div>
    </div>
    <section class="card stage" id="app-stage" aria-label="Borrowers as ledges on a cliff, and losses as water in a basin">
      <div class="plot">
        <div class="canvas" id="app-canvas"></div>
        <div class="overlay" id="app-overlay"></div>
        <div class="loading" id="app-loading">Running the stress test</div>
      </div>
      <div class="legend" id="app-legend"></div>
    </section>
    <p class="sentence story" id="app-sentence"></p>
    <section class="controls" aria-label="Markdown">
      <label class="slider" for="app-shock">
        <span class="slider-label"><span id="app-shock-what">Collateral marked down at once by</span> <b id="app-shock-value">0%</b></span>
        <input type="range" id="app-shock" min="0" max="40" step="0.5" value="0" />
        <span class="scale" aria-hidden="true"><span>0%</span><span>10%</span><span>20%</span><span>30%</span><span>40%</span></span>
      </label>
      <button id="app-play" class="btn play" type="button">${PLAY}</button>
    </section>
    <aside class="card cover-card" aria-labelledby="app-cover-h">
      <h2 class="section" id="app-cover-h">Cover for this market</h2>
      <div class="price" id="app-price"><span class="v"><span class="skeleton" style="width:3em"></span></span></div>
      <dl class="rows" id="app-terms"></dl>
      <div class="testnet" id="app-live" hidden></div>
      <p class="muted elsewhere" id="app-elsewhere" hidden></p>
      <nav class="links" aria-label="Proof">
        <a href="#/app/proof">See the testnet payout</a>
        <a href="#/app/verify">Rerun the numbers</a>
      </nav>
    </aside>
    <div class="app-ask" id="app-ask"></div>
    <dialog class="drawer" id="app-drawer" aria-labelledby="app-drawer-h">
      <div class="drawer-head">
        <h2 class="section" id="app-drawer-h"></h2>
        <button type="button" class="close" id="app-drawer-close" aria-label="Close">${CLOSE}</button>
      </div>
      <div class="drawer-body" id="drawer-proof"></div>
      <div class="drawer-body" id="drawer-verify"><p class="explain"><span class="skeleton" style="width:70%"></span></p></div>
    </dialog>
  </div>`;

/** Which drawer the hash asks for, if any. */
const drawerOf = (): Drawer | null => {
  const sub = location.hash.replace(/^#\/?/, "").split(/[/?]/)[1] ?? "";
  return sub in DRAWERS ? (sub as Drawer) : null;
};

export async function mountApp(root: HTMLElement): Promise<() => void> {
  root.innerHTML = VIEW;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
  let alive = true;
  const cleanups: (() => void)[] = [onCopy(root), () => (alive = false)];

  // ---------------------------------------------------------------- the drawer
  const dialog = $<HTMLDialogElement>("app-drawer");
  let verifyLoaded = false;
  function openDrawer(which: Drawer | null): void {
    if (!which) {
      if (dialog.open) dialog.close();
      return;
    }
    $("app-drawer-h").textContent = DRAWERS[which];
    $("drawer-proof").hidden = which !== "proof";
    $("drawer-verify").hidden = which !== "verify";
    if (which === "verify" && !verifyLoaded) {
      verifyLoaded = true;
      verifyFacts()
        .then((html) => ($("drawer-verify").innerHTML = html))
        .catch(() => {
          verifyLoaded = false;
          $("drawer-verify").innerHTML = `<p class="explain">The data did not arrive. Close and try again.</p>`;
        });
    }
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
  }
  dialog.addEventListener("close", () => {
    if (drawerOf()) history.replaceState(null, "", "#/app");
  });
  // A click on the backdrop lands on the dialog itself.
  dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());
  $("app-drawer-close").addEventListener("click", () => dialog.close());
  const onHash = () => openDrawer(drawerOf());
  window.addEventListener("hashchange", onHash);
  cleanups.push(() => window.removeEventListener("hashchange", onHash));

  // The live testnet cover fills the drawer's proof and the card's actions.
  import("./live.js")
    .then((m) => m.mountLive($("app-live"), $("drawer-proof")))
    .then((unmount) => cleanups.push(unmount))
    .catch(() => ($("drawer-proof").innerHTML = `<p class="explain">Monad testnet could not be reached. Try again shortly.</p>`));
  openDrawer(drawerOf());

  // ---------------------------------------------------------------- the market
  const d: Lending = await loadLending();
  const { markets, book, facts, prices } = d;
  let current = (markets.find((pm) => pm.market.id === REPLAYED_MARKET) ?? markets[0]) as PreparedMarket;
  let shock = 0;
  cleanups.push(mountAsk($("app-ask"), { market: () => pair(current) }));

  $("app-markets").innerHTML = markets.map((pm, i) => `<button type="button" data-i="${i}" aria-pressed="${pm === current}">${pair(pm)}</button>`).join("");
  $("app-sub").textContent = `Morpho on Monad, block ${book.blocks.to.number.toLocaleString("en-US")}`;

  const picture = new Picture();
  await picture.mount($("app-canvas"));
  $("app-loading").remove();
  cleanups.push(() => picture.destroy());

  /** The parts that change only with the market. */
  function drawMarketFacts(): void {
    const pm = current;
    const fact = facts.get(pm.market.id);
    const marksDown = fact?.shockMeans === "issuer marks down";
    const firstLoss = fact?.firstLoss ?? null;
    $("app-stats").innerHTML =
      stat("Borrowed", usdShort(debtUsd(pm)), `${pm.borrowers.length.toLocaleString("en-US")} borrowers`) +
      stat("First loss at", firstLoss === null ? "None" : pct(firstLoss), firstLoss === null ? "up to 100%" : `${marksDown ? "markdown" : "fall"} at once`, "first");
    $("app-shock-what").textContent = `${pm.market.collateral?.symbol ?? "Collateral"} ${marksDown ? "marked down" : "falls"} at once by`;

    const vault = mainVault(pm);
    const price = prices.get(vault.name);
    $("app-price").innerHTML = price
      ? `<span class="v">${rate(price.premiumOnSupply)}</span><span class="k">of supply a year</span>`
      : `<span class="v">Not priced</span>`;
    const row = (k: string, v: string) => `<div class="row"><dt>${k}</dt><dd>${v}</dd></div>`;
    $("app-terms").innerHTML =
      (price ? row("Limit", `${usdShort(price.limitUsd)}`) : "") + row("Main vault", `${vault.name}<br><span class="muted">${pct(vault.share)} of this market</span>`);

    const replayed = pm.market.id === REPLAYED_MARKET;
    $("app-live").hidden = !replayed;
    const elsewhere = $("app-elsewhere");
    const target = markets.findIndex((m) => m.market.id === REPLAYED_MARKET);
    elsewhere.hidden = replayed || target < 0;
    if (target >= 0) elsewhere.innerHTML = `Live cover runs on testnet for <button type="button" class="inline" data-i="${target}">${pair(markets[target] as PreparedMarket)}</button>.`;
  }

  function draw(): void {
    if (!alive) return;
    const pm = current;
    const m = drawMarket(d, pm, shock, picture, $("app-overlay"), $("app-legend"));
    const fact = facts.get(pm.market.id);
    const coll = pm.market.collateral?.symbol ?? "collateral";
    const word = m.marksDown ? "markdown" : "fall";
    const firstLoss = fact?.firstLoss ?? null;
    $("app-headline").innerHTML =
      shock <= 0
        ? firstLoss === null
          ? `No ${word} of ${coll}, even to zero, costs depositors`
          : `Depositors first lose at a <b>${pct(firstLoss)}</b> ${word}`
        : m.total <= 0
          ? `A ${pct(shock)} ${word} costs depositors nothing`
          : `A ${pct(shock)} ${word} leaves <b>${usdShort(m.total)}</b> unpaid`;
    const depth = fact?.exit?.depthUsd;
    const oracle = fact?.oracleKind && !fact.oracleKind.depegReachesOracle ? `Its oracle reads ${ORACLE_READS[fact.oracleKind.kind] ?? "a reported figure"}, so a market sell-off alone would not move it.` : "";
    $("app-sentence").textContent =
      shock <= 0
        ? oracle || `Each ledge is debt liquidated at that ${word}.`
        : m.total <= 0
          ? "Every position's collateral still covers its debt."
          : depth !== undefined && depth !== null
            ? `Liquidators can sell only ${usdShort(depth)} of ${coll} on Monad inside their incentive, so ${usdShort(m.unrealised)} is never written off.`
            : m.depositors <= 0
              ? `Spillway proves the shortfall from Morpho's positions and pays all ${usdShort(m.total)}.`
              : `Spillway pays ${usdShort(m.coverPaid)} and depositors lose ${usdShort(m.depositors)}.`;
    $("app-shock-value").textContent = pct(shock);
    $("app-shock").style.setProperty("--fill", `${(shock / 0.4) * 100}%`);
    $("app-stage").classList.toggle("loss", m.depositors > 0);
  }

  // ---------------------------------------------------------------- play: the story in one go
  const player = new Player(
    () => shock,
    (x) => {
      shock = Math.round(x * 2000) / 2000;
      ($("app-shock") as HTMLInputElement).value = String(shock * 100);
      draw();
    },
  );
  const stop = () => {
    player.stop();
    $("app-play").innerHTML = PLAY;
  };
  $("app-play").addEventListener("click", () => {
    if (player.playing) return stop();
    $("app-play").innerHTML = STOP;
    void player.play(storyOf(d, current)).then(() => !player.playing && ($("app-play").innerHTML = PLAY));
  });
  cleanups.push(stop);

  $("app-shock").addEventListener("input", (e) => {
    stop();
    shock = Number((e.target as HTMLInputElement).value) / 100;
    draw();
  });
  const onMarket = (e: Event) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-i]");
    if (!b) return;
    stop();
    current = markets[Number(b.dataset.i)] as PreparedMarket;
    root.querySelectorAll<HTMLButtonElement>("#app-markets button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.i === b.dataset.i)));
    drawMarketFacts();
    draw();
  };
  $("app-markets").addEventListener("click", onMarket);
  $("app-elsewhere").addEventListener("click", onMarket);
  const resize = new ResizeObserver(() => requestAnimationFrame(draw));
  resize.observe($("app-stage"));
  cleanups.push(() => resize.disconnect());
  drawMarketFacts();
  draw();
  return () => {
    if (dialog.open) dialog.close();
    cleanups.forEach((f) => f());
  };
}
