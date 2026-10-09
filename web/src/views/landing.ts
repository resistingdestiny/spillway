// The landing page: what Spillway does, a landscape of the biggest vaults, how it works told as one
// check playing in a small copy of the checker, three numbers, a note for those who back the cover,
// questions, and the way into the checker.

import "../check.css";
import "../landing.css";
import "../hero.css";

import deployment from "../../../contracts/deployments/monad-testnet-lending.json";
import replay from "../../../contracts/replay/testnet-wstETH-WETH-unrealised-25.json";
import * as Vaults from "../vaults.js";
import { dollarsShort, loadBook } from "../vaults.js";
import * as hero from "./hero.js";
import { REPO } from "./verify.js";

const PAID = replay.onChain.paid.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CLAIM_TX = `${deployment.explorer}/tx/${deployment.events.claimShortfall}`;
const ext = `target="_blank" rel="noopener"`;
const ARROW = `<span aria-hidden="true">&rarr;</span>`;
const CHEVRON = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const img = (src: string, w: number, h: number, alt: string, cls = "", eager = false) =>
  `<img class="${cls}" src="${src}" width="${w}" height="${h}" alt="${alt}" ${eager ? `fetchpriority="high"` : `loading="lazy" decoding="async"`} />`;
const sk = (w: string) => `<span class="skeleton" style="width:${w}"></span>`;

const FAQ: [string, string][] = [
  ["What is a Morpho vault?", "A vault pools depositors' money and lends it to borrowers who post collateral, such as wstETH. Its curator picks which loans it makes."],
  ["What loss does Spillway cover?", "The loss a vault's depositors take when a collateral price drops so suddenly that some loans end up worth more than their collateral. Cover pays your share of that loss, up to its limit."],
  ["How is the price set?", "We test every loan in the vault against sudden drops, then weigh the losses by how often that kind of collateral has failed before. The yearly price follows from both."],
  ["Who pays the claims?", "People who back the cover put up money that holds every limit in full, and they earn the price depositors pay. Claims pay from that money."],
  ["Is this live?", "Cover runs on Monad testnet during the hackathon, and it has already paid a claim there. The risk numbers use real Monad mainnet data."],
  ["Can I check the numbers?", `Yes. Every figure comes from a published snapshot that anyone can rerun, and <a href="#/check/verify">the verify page</a> lists the commands.`],
];

const VIEW = `
  <div class="landing">
    <section class="lhero" aria-labelledby="hero-h">
      <span class="how-mark" id="sec-how" aria-hidden="true"></span>
      <div class="hero-stage" id="hero-stage">
        <div class="hero-scene" id="hero-scene">
          <div class="wrap hero-wrap guides">
            <div class="eyebrow">Morpho vaults on Monad</div>
            <h1 class="h1" id="hero-h">Insurance for your Monad lending deposits</h1>
            <p class="hero-sub">See what a sudden crash would cost your vault, and cover it. Claims pay out automatically.</p>
            <div class="cta-row">
              <a class="btn" href="#/check">Check your vault</a>
              <a class="btn outline" href="#/" data-scroll="how">How it works</a>
            </div>
          </div>
          <div class="wrap hero-art" id="hero-art"></div>
        </div>
        <canvas class="ribbons" id="ribbons" aria-hidden="true"></canvas>
        <div class="wrap story-wrap" id="story-wrap"></div>
      </div>
    </section>

    <section class="figures" aria-label="What we checked">
      <div class="wrap numbers" id="numbers">
        <div class="num"><span class="v">${sk("2em")}</span><span class="k">vaults checked</span></div>
        <div class="num"><span class="v">${sk("3em")}</span><span class="k">deposits checked</span></div>
        <div class="num"><span class="v">${sk("3em")}</span><span class="k">loans tested</span></div>
      </div>
    </section>

    <section class="backers" aria-labelledby="back-h">
      <div class="wrap split mist-split">
        <div>
          <div class="eyebrow">For those who back the cover</div>
          <h2 class="h2" id="back-h">Back the cover and earn the premium</h2>
          <p class="lead">Put up testnet money that pays claims, and earn the price depositors pay for their cover.</p>
          <a class="more" href="#/check">See how ${ARROW}</a>
        </div>
        <figure class="split-art">${img("img/vaults.webp", 900, 730, "Stacked white vault blocks with a channel of blue water running between them")}</figure>
      </div>
    </section>

    <section class="faq" aria-labelledby="faq-h" id="sec-faq">
      <div class="wrap faq-wrap">
        <div><div class="eyebrow">Questions</div><h2 class="h2" id="faq-h">Common questions</h2></div>
        <div class="accordion">
          ${FAQ.map(([q, a]) => `<details name="faq"><summary>${CHEVRON}<span>${q}</span></summary><p>${a}</p></details>`).join("")}
        </div>
      </div>
    </section>

    <section class="band dark closing" aria-labelledby="close-h">
      <div class="wrap band-wrap center">
        <h2 class="h2" id="close-h">Check your vault in one click</h2>
        <a class="btn light" href="#/check">Check your vault</a>
      </div>
    </section>

    <footer class="foot">
      <div class="wrap foot-grid">
        <div class="foot-brand">
          <span class="brand-name">Spillway</span>
          <p>Insurance for Morpho vaults on Monad. Built for Monad Metropolis, October 2026.</p>
        </div>
        <nav aria-label="Product"><h3>Product</h3><a href="#/check">Check a vault</a><button type="button" class="foot-ask" data-ask>Ask Spillway</button><a href="#/perpl">Perpl</a></nav>
        <nav aria-label="Proof"><h3>Proof</h3><a href="#/check/proof">Testnet payout</a><a href="#/check/verify">Rerun the numbers</a></nav>
        <nav aria-label="Code"><h3>Code</h3><a href="${REPO}" ${ext}>GitHub</a></nav>
      </div>
    </footer>
  </div>`;

export async function mountLanding(root: HTMLElement): Promise<() => void> {
  root.innerHTML = VIEW;
  const cleanups: (() => void)[] = [];
  const onAsk = (e: Event) => (e.target as HTMLElement).closest("[data-ask]") && document.querySelector<HTMLButtonElement>(".ask-fab")?.click();
  root.addEventListener("click", onAsk);
  cleanups.push(() => root.removeEventListener("click", onAsk));

  // The story loads beside the data it draws.
  const [book, story] = await Promise.all([loadBook(), import("./story.js")]);
  (root.querySelector("#hero-art") as HTMLElement).innerHTML = hero.LAND;
  (root.querySelector("#story-wrap") as HTMLElement).innerHTML = story.storyHtml(`<p class="ss-proof">It has paid ${PAID} tUSD on Monad testnet. <a href="${CLAIM_TX}" ${ext}>View it</a></p>`, Vaults);
  const s = book.bundle.summary;
  const nums = root.querySelectorAll<HTMLElement>("#numbers .v");
  const set = (i: number, v: string) => nums[i] && (nums[i].textContent = v);
  set(0, book.bundle.vaults.length.toLocaleString("en-US"));
  set(1, dollarsShort(s.supplyUsd));
  set(2, s.borrowers.toLocaleString("en-US"));
  cleanups.push(hero.mountLand(root, book), story.mountStory(root, book, Vaults));
  return () => cleanups.forEach((f) => f());
}
