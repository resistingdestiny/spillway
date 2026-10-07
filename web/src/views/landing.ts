// The landing page: what Spillway does, the flood picture for the largest market playing its story,
// the live figures, the testnet proof and who it is for.

import type { PreparedMarket } from "@spillway/lending";
import deployment from "../../../contracts/deployments/monad-testnet-lending.json";
import replay from "../../../contracts/replay/testnet-wstETH-WETH-unrealised-25.json";
import { mountAsk } from "../agent/widget.js";
import { type Lending, Player, REPLAYED_MARKET, drawMarket, loadLending, pct, rate, storyOf } from "../market.js";
import { usdShort } from "../overlay.js";
import { Picture } from "../picture.js";
import { REPO, copyable, onCopy } from "./verify.js";

/** The vault whose cover price the landing page quotes. */
const QUOTED_VAULT = "Steakhouse Prime ETH";

const usdM = (n: number) => `$${(n / 1e6).toFixed(1)}M`;
const tusd = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PAID = tusd(replay.onChain.paid);
const SHORTFALL = tusd(replay.onChain.marketShortfall);
const CLAIM_TX = `${deployment.explorer}/tx/${deployment.events.claimShortfall}`;

const ARROW = `<span aria-hidden="true">&rarr;</span>`;
const icon = (body: string) => `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const MODULES = [
  {
    name: "Watch",
    text: "Every Morpho market on Monad, stress-tested position by position.",
    href: "#/app",
    icon: icon(`<path d="M5 4v20"/><path d="M5 9h11"/><path d="M5 14h7"/><path d="M5 19h14"/>`),
  },
  {
    name: "Price",
    text: "Cover priced from the test and from how often collateral has failed.",
    href: "#/app",
    icon: icon(`<circle cx="9" cy="9" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M20 8L8 20"/>`),
  },
  {
    name: "Cover",
    text: "Underwriters back each policy in full.",
    href: "#/app",
    icon: icon(`<rect x="5" y="15" width="18" height="5" rx="1" fill="var(--accent)" stroke="none"/><path d="M4 7v13a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V7"/>`),
  },
  {
    name: "Pay",
    text: "Claims proved from Morpho's own data, with no vote.",
    href: "#/app/proof",
    icon: icon(`<path d="M14 4v12"/><path d="M9 11l5 5 5-5"/><path d="M5 21h18"/>`),
  },
  {
    name: "Verify",
    text: "Every number reruns from public data.",
    href: "#/app/verify",
    icon: icon(`<circle cx="14" cy="14" r="9.5"/><path d="M9.5 14.2l3 3 6-6.2"/>`),
  },
];

const AUDIENCE = [
  ["Depositors", "See what a markdown would cost you, and cover it."],
  ["Curators", "Show the stress test behind every market your vault supplies."],
  ["Underwriters", "Earn the premium on capital that backs each policy in full."],
  ["Monad", "Lending markets whose risk anyone can price and check."],
];

const sk = (w: string) => `<span class="skeleton" style="width:${w}"></span>`;

const VIEW = `
  <div class="landing">
    <section class="hero-band">
      <div class="hero-text">
        <div class="overline">Morpho on Monad</div>
        <h1 class="display">Cover for Monad lending, priced in public</h1>
        <p class="lede">Depositors buy cover priced from a public stress test, and claims pay from Morpho's own data.</p>
        <div class="cta-row">
          <a class="btn" href="#/app">Open the app</a>
          <a class="btn secondary" href="#/app/proof">See it pay</a>
        </div>
      </div>
      <figure class="hero-picture">
        <div class="card stage" id="hero-stage" aria-label="wstETH/WETH: borrowers as ledges on a cliff, and losses as water in a basin">
          <div class="plot">
            <div class="canvas" id="hero-canvas"></div>
            <div class="overlay" id="hero-overlay"></div>
            <div class="loading" id="hero-loading">Running the stress test</div>
          </div>
          <div class="legend" id="hero-legend"></div>
        </div>
        <ol class="story-steps" id="hero-steps" aria-live="polite">
          <li data-i="0">Today</li>
          <li data-i="1">First loss</li>
          <li data-i="2">25% markdown</li>
        </ol>
      </figure>
    </section>

    <section class="figures" aria-label="Live figures" id="figures">
      <div class="figure"><span class="v">${sk("4em")}</span><span class="k">borrowed on Monad's Morpho markets</span></div>
      <div class="figure"><span class="v">${sk("4em")}</span><span class="k">of debt behind oracles that cannot see a depeg</span></div>
      <div class="figure"><span class="v">${sk("3em")}</span><span class="k">a year to cover ${QUOTED_VAULT}</span></div>
      <div class="figure payout"><span class="v">${PAID}</span><span class="k">tUSD paid on Monad testnet</span></div>
    </section>

    <section class="block" aria-labelledby="mod-h">
      <h2 class="title" id="mod-h">From stress test to payout</h2>
      <div class="modules">
        ${MODULES.map((m, i) => `<a class="module" href="${m.href}"><span class="num">0${i + 1}</span>${m.icon}<h3>${m.name}</h3><p>${m.text}</p></a>`).join("")}
      </div>
    </section>

    <section class="block ask-block" aria-labelledby="ask-h">
      <h2 class="title" id="ask-h">Ask Spillway</h2>
      <p class="lede">Ask about any market, vault or payout, answered from the same public data.</p>
      <div id="ask"></div>
    </section>

    <section class="block proof-block" aria-labelledby="proof-h">
      <h2 class="title" id="proof-h">Paid on Monad testnet</h2>
      <div class="proof-grid">
        <div class="card proof-paid">
          <span class="k">Paid to the main depositor</span>
          <span class="v">${PAID}<small>tUSD</small></span>
          <p>On a proved ${SHORTFALL} tUSD shortfall after a 25% markdown, with nobody able to liquidate.</p>
          <a href="${CLAIM_TX}" target="_blank" rel="noopener">View the claim on Monadscan ${ARROW}</a>
        </div>
        <div class="card proof-hash">
          <span class="k">Rerun hash</span>
          <div id="proof-hash">${sk("90%")}</div>
          <p>SHA-256 of the Monad snapshot behind every figure on this page.</p>
          <a href="#/app/verify">Rerun it ${ARROW}</a>
        </div>
      </div>
    </section>

    <section class="block" aria-labelledby="who-h">
      <h2 class="title" id="who-h">Who it is for</h2>
      <dl class="audience">
        ${AUDIENCE.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}
      </dl>
    </section>

    <section class="closing">
      <h2 class="display">Find the first loss in your market</h2>
      <a class="btn" href="#/app">Open the app</a>
    </section>

    <footer class="foot">
      <span class="foot-brand">Spillway</span>
      <span class="muted">Built for Monad Metropolis, October 2026</span>
      <nav aria-label="Elsewhere">
        <a href="${REPO}" target="_blank" rel="noopener">GitHub</a>
        <a href="#/app">App</a>
        <a href="#/perpl">Perpl</a>
      </nav>
    </footer>
  </div>`;

export async function mountLanding(root: HTMLElement): Promise<() => void> {
  root.innerHTML = VIEW;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
  let alive = true;
  const cleanups: (() => void)[] = [onCopy(root), () => (alive = false), mountAsk($("ask"), { heading: false })];

  const d: Lending = await loadLending();
  const { bundle } = d;
  const quoted = d.prices.get(QUOTED_VAULT);
  const figures = root.querySelectorAll<HTMLElement>("#figures .v");
  const set = (i: number, v: string) => figures[i] && (figures[i].innerHTML = v);
  set(0, usdM(bundle.summary.debtUsd));
  set(1, usdM(bundle.summary.debtIssuerMarksDownUsd));
  set(2, quoted ? rate(quoted.premiumOnSupply) : "Not priced");
  $("proof-hash").innerHTML = copyable(bundle.manifest.fixture.sha256);

  // ---------------------------------------------------------------- the hero picture
  const pm = (d.markets.find((m) => m.market.id === REPLAYED_MARKET) ?? d.markets[0]) as PreparedMarket;
  const story = storyOf(d, pm);
  const picture = new Picture();
  await picture.mount($("hero-canvas"));
  $("hero-loading").remove();
  cleanups.push(() => picture.destroy());

  const steps = [...root.querySelectorAll<HTMLElement>("#hero-steps li")];
  steps[1] && (steps[1].textContent = `First loss at ${pct(story[1] ?? 0)}`);
  let shock = 0;
  let reached = 0;
  const draw = () => {
    if (!alive) return;
    const m = drawMarket(d, pm, shock, picture, $("hero-overlay"), $("hero-legend"));
    $("hero-stage").classList.toggle("loss", m.depositors > 0);
    steps.forEach((s, i) => s.setAttribute("aria-current", String(i === reached)));
    if (reached === 2 && steps[2]) steps[2].textContent = `25% markdown, ${usdShort(m.total)} unpaid`;
  };
  const player = new Player(
    () => shock,
    (x, i) => {
      shock = x;
      reached = i;
      draw();
    },
  );
  cleanups.push(() => player.stop());

  if (player.reduced) {
    // A still of the story's end.
    shock = story[2] ?? 0.25;
    reached = 2;
    draw();
  } else {
    // Play only while the picture is on screen.
    const seen = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting && !player.playing) void player.play(story, true);
      else if (!e?.isIntersecting) player.stop();
    });
    seen.observe($("hero-stage"));
    cleanups.push(() => seen.disconnect());
  }
  const resize = new ResizeObserver(() => requestAnimationFrame(draw));
  resize.observe($("hero-stage"));
  cleanups.push(() => resize.disconnect());
  draw();
  return () => cleanups.forEach((f) => f());
}
