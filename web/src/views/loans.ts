// The "See every loan" drawer: the flood picture of a vault's biggest Morpho market, with its own
// slider. Loaded on demand, so the engine and the renderer are only fetched when someone opens it.

import type { PreparedMarket } from "@spillway/lending";
import { MAX_MOVE } from "../layout.js";
import { type Lending, debtUsd, drawMarket, loadLending, pair, pct } from "../market.js";
import { usdShort } from "../overlay.js";
import { Picture } from "../picture.js";
import type { Vault } from "../vaults.js";

const VIEW = `
  <p class="explain" id="loans-what"></p>
  <section class="card stage" id="loans-stage" aria-label="Loans as ledges on a cliff, and losses as water in a basin">
    <div class="plot"><div class="canvas" id="loans-canvas"></div><div class="overlay" id="loans-overlay"></div></div>
    <div class="legend" id="loans-legend"></div>
  </section>
  <label class="slider loans-slider" for="loans-drop">
    <span class="slider-label"><span id="loans-label">Sudden drop</span> <b id="loans-v">0%</b></span>
    <input type="range" id="loans-drop" min="0" max="${MAX_MOVE * 100}" step="0.5" value="0" />
  </label>
  <p class="note">Each ledge is a group of loans that goes bad at that drop. The water is the loss: cover takes it first, then depositors.</p>`;

/** The market where the vault has the most money lent out to borrowers. */
function biggestMarket(d: Lending, v: Vault): PreparedMarket | null {
  let best: { pm: PreparedMarket; usd: number } | null = null;
  for (const pm of d.prep.markets) {
    if (pm.borrowers.length === 0) continue;
    const usd = pm.suppliers.filter((s) => s.vault === v.address).reduce((a, s) => a + s.supplied, 0) * pm.loanUsd;
    if (usd > 0 && (!best || usd > best.usd)) best = { pm, usd };
  }
  return best?.pm ?? null;
}

export async function mountLoans(el: HTMLElement) {
  const d = await loadLending();
  el.innerHTML = VIEW;
  const $ = (id: string) => el.querySelector(`#${id}`) as HTMLElement;
  const picture = new Picture();
  await picture.mount($("loans-canvas"));
  const slider = $("loans-drop") as HTMLInputElement;
  let pm: PreparedMarket | null = null;
  let drop = 0;

  const paint = () => {
    if (!pm) return;
    const m = drawMarket(d, pm, drop, picture, $("loans-overlay"), $("loans-legend"));
    $("loans-stage").classList.toggle("loss", m.depositors > 0);
    $("loans-v").textContent = pct(drop);
    slider.value = String(drop * 100);
    slider.style.setProperty("--fill", `${(drop / MAX_MOVE) * 100}%`);
  };
  slider.addEventListener("input", () => ((drop = Number(slider.value) / 100), paint()));
  const resize = new ResizeObserver(() => requestAnimationFrame(paint));
  resize.observe($("loans-stage"));

  return {
    draw(v: Vault, at: number): void {
      pm = biggestMarket(d, v);
      $("loans-stage").hidden = !pm;
      if (!pm) {
        $("loans-what").textContent = `${v.name} has no borrowers in the snapshot.`;
        return;
      }
      $("loans-what").textContent = `${v.name}'s biggest market is ${pair(pm)}: ${pm.borrowers.length.toLocaleString("en-US")} loans, ${usdShort(debtUsd(pm))} borrowed.`;
      $("loans-label").textContent = `${pm.market.collateral?.symbol ?? "Collateral"} suddenly drops`;
      drop = Math.min(at, MAX_MOVE);
      requestAnimationFrame(paint);
    },
    destroy(): void {
      resize.disconnect();
      picture.destroy();
    },
  };
}
