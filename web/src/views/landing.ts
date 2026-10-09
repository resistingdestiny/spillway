// The landing page: the hero, the pipeline band, the capabilities with the live figures, the
// product rows with the real components, the suite, the proof, Ask Spillway, roles and resources.

import "../landing.css";

import type { LendingBundle, PreparedMarket } from "@spillway/lending";
import deployment from "../../../contracts/deployments/monad-testnet-lending.json";
import replay from "../../../contracts/replay/testnet-wstETH-WETH-unrealised-25.json";
import { mountAsk } from "../agent/widget.js";
import { load } from "../load.js";
import { COVER_SHOCK, type Lending, Player, REPLAYED_MARKET, debtUsd, drawMarket, loadLending, mainVault, pair, pct, rate, storyOf } from "../market.js";
import { usdShort } from "../overlay.js";
import { Picture } from "../picture.js";
import { mountPipeline, pipelineHtml } from "../pipeline.js";
import { REPO } from "./verify.js";

/** The vault whose cover price the landing page quotes. */
const QUOTED_VAULT = "Steakhouse Prime ETH";
const BUNDLE = "data/lending/bundle.json";

const usdM = (n: number) => `$${(n / 1e6).toFixed(1)}M`;
const tusd = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PAID = tusd(replay.onChain.paid);
const SHORTFALL = tusd(replay.onChain.marketShortfall);
const FORECAST = tusd(replay.engineForecast.holderShare);
const CLAIM_TX = `${deployment.explorer}/tx/${deployment.events.claimShortfall}`;
const shortHash = (h: string) => `${h.slice(0, 8)}...${h.slice(-6)}`;
const doc = (path: string) => `${REPO}/blob/main/${path}`;
const tree = (path: string) => `${REPO}/tree/main/${path}`;
const ext = `target="_blank" rel="noopener"`;

const ARROW = `<span aria-hidden="true">&rarr;</span>`;
const CHEVRON = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const icon = (body: string) => `<svg width="26" height="26" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const img = (src: string, w: number, h: number, alt: string, cls = "", eager = false) =>
  `<img class="${cls}" src="${src}" width="${w}" height="${h}" alt="${alt}" ${eager ? `fetchpriority="high"` : `loading="lazy" decoding="async"`} />`;
const sk = (w: string) => `<span class="skeleton" style="width:${w}"></span>`;
const head = (over: string, title: string, text: string, id = "") => `
  <div class="wrap sec-head guides">
    <div><div class="eyebrow">${over}</div><h2 class="h2"${id ? ` id="${id}"` : ""}>${title}</h2></div>
    <p class="aside">${text}</p>
  </div>`;
/** A spacer between sections: hairlines across the page, small circles where they cross the frame. */
const RULE = `<div class="rule" aria-hidden="true"><div class="wrap"><i></i></div></div>`;

interface Module {
  key: string;
  name: string;
  title: string;
  text: string;
  points: [string, string][];
  app: string;
  docs: string;
  icon: string;
  panel: string;
}

const MODULES: Module[] = [
  {
    key: "watch",
    name: "Watch",
    title: "Every market, position by position",
    text: "Spillway reads each Morpho market on Monad and finds the markdown where its depositors first lose.",
    points: [
      ["Read from chain state", "Positions come from Morpho's own storage at one fixed block."],
      ["Thin exits counted", "Liquidators act only where Monad's exchanges can absorb the sale."],
      ["Oracles checked", "Each market records whether its oracle would see a depeg."],
    ],
    app: "#/app",
    docs: doc("docs/LENDING.md"),
    icon: icon(`<path d="M4 20l6-6 4 4 10-10"/><circle cx="10" cy="14" r="1.6"/><circle cx="14" cy="18" r="1.6"/><path d="M4 24h20"/>`),
    panel: img("img/gauge.webp", 640, 640, "A white gauge post standing in a pool of blue water", "spot"),
  },
  {
    key: "price",
    name: "Price",
    title: "A yearly price from the test",
    text: "Cover is priced from the stress test and from how often collateral has failed.",
    points: [
      ["Failure history", "Rates come from collateral failures between 2022 and 2026."],
      ["One rate per vault", "Each vault gets one yearly rate on its supply."],
      ["Published inputs", "Every price names the inputs behind it."],
    ],
    app: "#/app",
    docs: doc("docs/RESEARCH.md"),
    icon: icon(`<circle cx="9" cy="9" r="2.6"/><circle cx="19" cy="19" r="2.6"/><path d="M21 7L7 21"/>`),
    panel: img("img/tokens.webp", 640, 640, "A stack of white tokens beside a pool of blue water", "spot"),
  },
  {
    key: "cover",
    name: "Cover",
    title: "Policies backed in full",
    text: "Underwriters deposit the capital that backs each policy in full, and earn its premium.",
    points: [
      ["Beside the vault", "Depositors keep their vault position and add cover on top."],
      ["Sized to a sudden markdown", `Cover keeps depositors whole up to a ${pct(COVER_SHOCK)} markdown at once.`],
      ["Premium to underwriters", "Underwriters earn the premium paid on each policy."],
    ],
    app: "#/app",
    docs: doc("contracts/README.md"),
    icon: icon(`<path d="M14 4l9 3.5v6c0 5.5-4 9.5-9 10.5-5-1-9-5-9-10.5v-6z"/><path d="M9 15h10"/>`),
    panel: `<div class="frag-card" data-frag="cover"><div class="frag-top"><span>Cover for ${QUOTED_VAULT}</span><span class="tag-live">Priced</span></div><div class="frag-big" data-fill="rate">${sk("3em")}</div><div class="frag-sub">of supply a year</div><dl class="frag-rows"><div><dt>Limit</dt><dd data-fill="limit">${sk("3em")}</dd></div><div><dt>Sized to</dt><dd>${pct(COVER_SHOCK)} markdown</dd></div></dl></div>`,
  },
  {
    key: "pay",
    name: "Pay",
    title: "Claims proved from chain state",
    text: "A claim pays the shortfall proved from Morpho's positions, with no vote.",
    points: [
      ["No claims vote", "The contract checks the proof itself and pays."],
      ["One transaction", "The proof and the payout settle together."],
      ["Paid on testnet", `${PAID} tUSD paid on Monad testnet.`],
    ],
    app: "#/app/proof",
    docs: tree("contracts/replay"),
    icon: icon(`<path d="M14 4v13"/><path d="M8.5 11.5L14 17l5.5-5.5"/><path d="M5 23h18"/>`),
    panel: img("img/chute.webp", 640, 640, "A white chute carrying a ribbon of blue water", "spot"),
  },
  {
    key: "verify",
    name: "Verify",
    title: "Every number reruns",
    text: "Each figure names its snapshot, its hash and the command that rebuilds it.",
    points: [
      ["Snapshot hash", "Your browser hashes the snapshot this page uses."],
      ["Rebuilt from events", "The indexer replays Morpho's events and matches chain storage."],
      ["Open source", "The engine, contracts and site are in one public repository."],
    ],
    app: "#/app/verify",
    docs: doc("indexer/README.md"),
    icon: icon(`<circle cx="14" cy="14" r="9.5"/><path d="M9.5 14.2l3 3 6-6.2"/>`),
    panel: img("img/lens.webp", 640, 640, "A white lens resting over a tile of blue water", "spot"),
  },
  {
    key: "ask",
    name: "Ask",
    title: "An analyst on the same engine",
    text: "Ask Spillway answers plain questions with figures from the engine and Monad testnet.",
    points: [
      ["Tools listed", "Each answer shows the tools behind its numbers."],
      ["Knows your market", "In the app it reads the market on screen."],
      ["Not advice", "It explains the numbers and stops there."],
    ],
    app: "#/app",
    docs: doc("agent/README.md"),
    icon: icon(`<path d="M5 6h18v12H12l-5 4v-4H5z"/><path d="M10 11h8"/><path d="M10 14h5"/>`),
    panel: `<div class="frag-chat"><div class="frag-q">Has the cover ever paid?</div><div class="frag-a"><span class="line"></span><span class="line short"></span><div class="frag-tools"><span>Monad testnet</span><span>Stress test</span></div></div></div>`,
  },
];

const ASK_FEATURES: [string, string, string][] = [
  ["Runs the engine", "Answers come from Spillway's own stress test, run for your question.", `<circle cx="60" cy="40" r="12"/><circle cx="60" cy="40" r="26" stroke-dasharray="3 4"/><path d="M20 40h14M86 40h14"/><circle cx="20" cy="40" r="3"/><circle cx="100" cy="40" r="3"/>`],
  ["Every figure cited", "Each answer lists the tools behind its numbers.", `<rect x="34" y="14" width="52" height="34" rx="2"/><path d="M42 24h30M42 31h22M42 38h26"/><path d="M48 48l-10 18M72 48l10 18" stroke-dasharray="3 3"/><rect x="28" y="64" width="18" height="10" rx="1"/><rect x="74" y="64" width="18" height="10" rx="1"/>`],
  ["Reads the chain live", "Payouts and policies come from Monad testnet as you ask.", `<path d="M14 56h92" stroke-dasharray="3 4"/><rect x="18" y="44" width="16" height="12"/><rect x="40" y="38" width="16" height="18"/><rect x="62" y="30" width="16" height="26"/><rect x="84" y="20" width="16" height="36" class="w"/>`],
  ["Says when it can not tell", "If no tool covers the question, it says so plainly.", `<circle cx="60" cy="40" r="22"/><path d="M53 33a7 7 0 1 1 9 7v4"/><circle cx="62" cy="51" r="1.2"/>`],
  ["No advice", "It explains what the numbers mean and never what to buy.", `<rect x="30" y="18" width="60" height="44" rx="2"/><path d="M30 30h60"/><path d="M48 44l24 0" /><path d="M40 72h40" stroke-dasharray="3 4"/>`],
  ["Open source", "The agent and its tools are in the public repository.", `<path d="M44 26L28 40l16 14M76 26l16 14-16 14"/><path d="M66 20L54 60"/>`],
];

const ROLES = [
  ["Depositors", "See what a markdown would cost you in the vault you hold, and cover that loss."],
  ["Curators", "Show the stress test behind every market your vault supplies, next to the cover for it."],
  ["Underwriters", "Earn the premium on capital that backs each policy in full."],
  ["Monad", "Lending markets whose risk anyone can price, check and rerun."],
];

const RESOURCES = [
  ["Design", "How the stress test and the cover work", doc("docs/LENDING.md"), `<path d="M10 52h100" stroke-dasharray="3 4"/><path d="M10 20h22v32M32 30h24v22M56 38h26v14M82 44h28v8"/>`],
  ["Research", "Collateral failures, oracles and exit liquidity", doc("docs/RESEARCH.md"), `<circle cx="60" cy="36" r="22"/><ellipse cx="60" cy="36" rx="22" ry="8"/><ellipse cx="60" cy="36" rx="8" ry="22"/><circle cx="60" cy="36" r="3" class="f"/>`],
  ["Code", "The cover contracts, with the testnet replay", tree("contracts"), `<path d="M24 18l12 8v28l-12-8zM48 18l12 8v28l-12-8zM72 18l12 8v28l-12-8z"/><path d="M14 40h92" stroke-dasharray="3 4"/>`],
];

const PROOFS = [
  {
    text: `${PAID} tUSD paid in one transaction, against an engine forecast of ${FORECAST}.`,
    who: "Monad testnet, the ShortfallClaimed event",
    href: CLAIM_TX,
    link: "View the claim on Monadscan",
  },
  {
    text: "The Morpho book rebuilt from events matches chain storage for all 130 markets and 1,109 positions.",
    who: "The indexer's reconciliation with the 6 October 2026 snapshot",
    href: doc("indexer/README.md"),
    link: "Read the reconciliation",
  },
];

const VIEW = `
  <div class="landing">
    <section class="lhero" aria-labelledby="hero-h">
      <div class="wrap hero-wrap guides">
        <div class="eyebrow">Cover for Morpho vaults on Monad</div>
        <h1 class="h1" id="hero-h">Cover for Monad lending, priced in public</h1>
        <p class="hero-sub">Depositors buy cover priced from a public stress test, paid from chain state.</p>
        <div class="cta-row">
          <a class="btn" href="#/app">Open the app</a>
          <a class="btn outline" href="#/app/proof">See it pay</a>
        </div>
      </div>
      <div class="wrap hero-art">
        ${img("img/dam.webp", 1536, 640, "A white clay dam holding a blue reservoir, with water running down its spillway, towers and cranes on the banks", "hero-img", true)}
      </div>
    </section>

    <section class="band dark" aria-labelledby="pipe-h" id="sec-product">
      <div class="wrap band-wrap">
        <div class="eyebrow light">How it works</div>
        <h2 class="h2 pipe-h" id="pipe-h">One platform from position to payout</h2>
        ${pipelineHtml()}
        <p class="pipe-note" id="pipe-note">One line for each open position on Monad's Morpho markets.</p>
      </div>
    </section>

    ${RULE}
    <section class="built" aria-label="Built on">
      <div class="wrap center"><div class="eyebrow">Built on</div></div>
      <div class="wrap built-row">
        ${["Monad", "Morpho", "Chainlink", "Envio", "Perpl"].map((n) => `<span class="mark">${n}</span>`).join("")}
      </div>
    </section>
    ${RULE}

    <section class="caps" aria-labelledby="caps-h">
      <div class="wrap center guides caps-head">
        <div class="eyebrow">Capabilities</div>
        <h2 class="h2" id="caps-h">Every Monad market, stress-tested in public</h2>
      </div>
      <div class="wrap flow dots">
        <div class="flow-chips" id="flow-chips" aria-hidden="true">${`<span class="chip-file">${sk("8em")}</span>`.repeat(6)}</div>
        <div class="flow-node" aria-hidden="true"><span></span></div>
        <div class="flow-card" id="flow-card">
          <div class="flow-title">wstETH/WETH</div>
          <div class="flow-row"><span class="flow-tick" aria-hidden="true"></span><span id="flow-first">First loss at ${sk("2em")}</span><code id="flow-block">${sk("6em")}</code></div>
          <div class="flow-dots" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
        </div>
      </div>
      <div class="wrap numbers" id="numbers">
        <div class="num"><span class="v">${sk("2em")}</span><span class="k">markets tested</span></div>
        <div class="num"><span class="v">${sk("3em")}</span><span class="k">positions read</span></div>
        <div class="num"><span class="v">${sk("3em")}</span><span class="k">of debt behind oracles that cannot see a depeg</span></div>
      </div>
    </section>

    ${RULE}
    <section class="band dark" aria-labelledby="cur-h">
      <div class="wrap band-wrap split">
        <div>
          <div class="eyebrow light">For curators</div>
          <h2 class="h2" id="cur-h">Cover that sits beside your vault</h2>
          <p class="band-text">Your depositors keep their vault position and add cover priced from the same public test. Nothing in the vault changes.</p>
          <a class="btn light" href="${doc("docs/LENDING.md")}" ${ext}>Learn more ${CHEVRON}</a>
        </div>
        <figure class="band-art">${img("img/vaults.webp", 900, 730, "Stacked white vault blocks with a channel of blue water running down between them")}</figure>
      </div>
    </section>
    ${RULE}

    <section class="features" aria-labelledby="feat-h">
      ${head("Product", "See the loss before it reaches you", "Each part runs on the same snapshot of Monad's Morpho book. What you see here are the live components.", "feat-h")}
      <div class="row-feature">
        <div class="wrap feature">
          <div class="feature-text">
            <div class="eyebrow">Stress test</div>
            <h3 class="h3">Drag the markdown and watch the water</h3>
            <p>Each ledge is a group of borrowers that breaks at that markdown. The water is the loss, and Spillway's cover takes it first.</p>
            <a class="more" href="#/app">Open the market ${ARROW}</a>
          </div>
          <div class="feature-panel">
            <div class="panel-card">
              <div class="card stage" id="hero-stage" aria-label="wstETH/WETH: borrowers as ledges on a cliff, and losses as water in a basin">
                <div class="plot">
                  <div class="canvas" id="hero-canvas"></div>
                  <div class="overlay" id="hero-overlay"></div>
                  <div class="loading" id="hero-loading">Running the stress test</div>
                </div>
                <div class="legend" id="hero-legend"></div>
              </div>
              <label class="slider mini" for="hero-shock">
                <span class="slider-label"><span>wstETH marked down at once by</span> <b id="hero-shock-value">0%</b></span>
                <input type="range" id="hero-shock" min="0" max="40" step="0.5" value="0" />
              </label>
            </div>
          </div>
        </div>
      </div>
      ${RULE}
      <div class="row-feature flip">
        <div class="wrap feature">
          <div class="feature-text">
            <div class="eyebrow">Price</div>
            <h3 class="h3">One yearly price for each vault</h3>
            <p>Priced on the vault's supply, with a limit set by the test. The rate comes from the stress test and from how often collateral has failed.</p>
            <a class="more" href="#/app">See every price ${ARROW}</a>
          </div>
          <div class="feature-panel">
            <div class="panel-card narrow">
              <div class="frag-card big">
                <div class="frag-top"><span>Cover for ${QUOTED_VAULT}</span><span class="tag-live">Priced</span></div>
                <div class="frag-big" id="price-rate">${sk("3em")}</div>
                <div class="frag-sub">of supply a year</div>
                <dl class="frag-rows">
                  <div><dt>Limit</dt><dd id="price-limit">${sk("3em")}</dd></div>
                  <div><dt>Market</dt><dd id="price-market">${sk("5em")}</dd></div>
                  <div><dt>First loss at</dt><dd id="price-first">${sk("2em")}</dd></div>
                </dl>
              </div>
            </div>
          </div>
        </div>
      </div>
      ${RULE}
      <div class="row-feature">
        <div class="wrap feature">
          <div class="feature-text">
            <div class="eyebrow">Payout</div>
            <h3 class="h3">Paid on Monad testnet in one transaction</h3>
            <p>The cover vault proved the shortfall from Morpho's positions and paid the depositor. Nobody voted on it.</p>
            <a class="more" href="#/app/proof">See the payout ${ARROW}</a>
          </div>
          <div class="feature-panel">
            <div class="panel-card narrow">
              <div class="frag-card big">
                <div class="frag-top"><span>Policy ${replay.policyId}, wstETH/WETH</span><span class="tag-paid">Paid</span></div>
                <div class="frag-big">${PAID}<small>tUSD</small></div>
                <div class="frag-sub">paid to the main depositor</div>
                <dl class="frag-rows">
                  <div><dt>Proved shortfall</dt><dd>${SHORTFALL} tUSD</dd></div>
                  <div><dt>Markdown</dt><dd>${pct(COVER_SHOCK)} at once</dd></div>
                  <div><dt>Transaction</dt><dd><a href="${CLAIM_TX}" ${ext}><code>${shortHash(deployment.events.claimShortfall)}</code></a></dd></div>
                </dl>
                <a class="more" href="${CLAIM_TX}" ${ext}>View on Monadscan ${ARROW}</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    ${RULE}
    <section class="suite" aria-labelledby="suite-h">
      ${head("The Spillway suite", "Six modules on one engine", "Every module reads the same snapshot through the same engine. Use one, or all six.", "suite-h")}
      <div class="wrap suite-body">
        <div class="suite-tabs" role="tablist" aria-label="Modules">
          ${MODULES.map((m, i) => `<button type="button" role="tab" id="tab-${m.key}" aria-controls="mod-${m.key}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${m.icon}<span>${m.name}</span></button>`).join("")}
        </div>
        ${MODULES.map(
          (m, i) => `
          <div class="suite-pane" role="tabpanel" id="mod-${m.key}" aria-labelledby="tab-${m.key}" ${i === 0 ? "" : "hidden"}>
            <div class="suite-detail">
              <div class="eyebrow">${m.name}</div>
              <h3 class="h3">${m.title}</h3>
              <p>${m.text}</p>
              <div class="accordion">
                ${m.points.map(([k, v], j) => `<details name="acc-${m.key}" ${j === 0 ? "open" : ""}><summary>${CHEVRON}${k}</summary><p>${v}</p></details>`).join("")}
              </div>
              <div class="cta-row">
                <a class="btn" href="${m.app}">Open in the app</a>
                <a class="more" href="${m.docs}" ${ext}>Read the docs ${ARROW}</a>
              </div>
            </div>
            <div class="suite-panel">${m.panel}</div>
          </div>`,
        ).join("")}
      </div>
    </section>

    ${RULE}
    <section class="proof" aria-labelledby="proof-h" id="sec-proof">
      <div class="wrap proof-panel">
        <div class="eyebrow" id="proof-h">Proof</div>
        <div class="proof-slides" aria-live="polite">
          ${PROOFS.map((p, i) => `<figure class="proof-slide" data-i="${i}" ${i === 0 ? "" : "hidden"}><blockquote class="proof-text">${p.text}</blockquote><figcaption><span>${p.who}</span><a href="${p.href}" ${ext}>${p.link} ${ARROW}</a></figcaption></figure>`).join("")}
        </div>
        <div class="pager">
          <button type="button" class="pager-btn" id="proof-prev" aria-label="Previous proof"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5L4 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <span class="pager-n" id="proof-n">01 / 0${PROOFS.length}</span>
          <button type="button" class="pager-btn" id="proof-next" aria-label="Next proof">${CHEVRON}</button>
        </div>
      </div>
    </section>
    ${RULE}

    <section class="ask-sec" aria-labelledby="ask-h" id="sec-ask">
      ${head("Ask Spillway", "An analyst that shows its work", "Ask about any market, vault or payout. Each answer comes from the engine and lists the tools it used.", "ask-h")}
      <div class="wrap ask-panel"><div id="ask"></div></div>
      <div class="wrap">
        <div class="eyebrow cards-over">Key features</div>
        <div class="cards">
          ${ASK_FEATURES.map(([k, v, d]) => `<article class="fcard"><svg class="diagram" viewBox="0 0 120 80" aria-hidden="true">${d}</svg><h3>${k}</h3><p>${v}</p></article>`).join("")}
        </div>
      </div>
    </section>

    ${RULE}
    <section class="roles" aria-labelledby="roles-h" id="sec-roles">
      <div class="wrap guides sec-head single"><div><div class="eyebrow">By role</div><h2 class="h2" id="roles-h">Built for everyone with money in a vault</h2></div></div>
      <div class="wrap role-grid">
        ${ROLES.map(([k, v]) => `<div class="role"><h3>${k}</h3><p>${v}</p></div>`).join("")}
      </div>
    </section>
    ${RULE}

    <section class="learn" aria-labelledby="learn-h">
      <div class="wrap guides sec-head single"><div><div class="eyebrow">Resources</div><h2 class="h2" id="learn-h">Learn how Spillway works</h2></div></div>
      <div class="wrap res-row">
        ${RESOURCES.map(([o, t, h, d], i) => `<a class="res" href="${h}" ${ext}><div class="res-art t${i}"><svg viewBox="0 0 120 72" aria-hidden="true">${d}</svg></div><div class="res-body"><span class="eyebrow">${o}</span><h3>${t}</h3><span class="more">Read on GitHub ${ARROW}</span></div></a>`).join("")}
      </div>
    </section>

    <section class="band dark closing" aria-labelledby="close-h">
      <div class="wrap band-wrap center">
        <h2 class="h2" id="close-h">Find the first loss in your market</h2>
        <a class="btn light" href="#/app">Open the app</a>
      </div>
    </section>

    <footer class="foot">
      <div class="wrap foot-grid">
        <div class="foot-brand">
          <span class="brand-name">Spillway</span>
          <p>Built for Monad Metropolis, October 2026.</p>
        </div>
        <nav aria-label="Product"><h3>Product</h3><a href="#/app">The app</a><a href="#/perpl">Perpl</a><a href="#/" data-scroll="ask">Ask Spillway</a></nav>
        <nav aria-label="Proof"><h3>Proof</h3><a href="#/app/proof">Testnet payout</a><a href="#/app/verify">Rerun the numbers</a><a href="${doc("indexer/README.md")}" ${ext}>Reconciliation</a></nav>
        <nav aria-label="Code"><h3>Code</h3><a href="${REPO}" ${ext}>GitHub</a><a href="${tree("contracts")}" ${ext}>Contracts</a><a href="${tree("lending")}" ${ext}>Engine</a></nav>
      </div>
    </footer>
  </div>`;

/** Vertical tabs with arrow keys, as a tablist should. */
function mountTabs(root: HTMLElement): () => void {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>(".suite-tabs [role=tab]")];
  const select = (t: HTMLButtonElement) => {
    for (const x of tabs) {
      const on = x === t;
      x.setAttribute("aria-selected", String(on));
      x.tabIndex = on ? 0 : -1;
      (root.querySelector(`#${x.getAttribute("aria-controls")}`) as HTMLElement).hidden = !on;
    }
  };
  const onClick = (e: Event) => {
    const t = (e.target as HTMLElement).closest<HTMLButtonElement>("[role=tab]");
    if (t) select(t);
  };
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const t = tabs[(i + step + tabs.length) % tabs.length] as HTMLButtonElement;
    select(t);
    t.focus();
  };
  const list = root.querySelector(".suite-tabs") as HTMLElement;
  list.addEventListener("click", onClick);
  list.addEventListener("keydown", onKey);
  return () => {
    list.removeEventListener("click", onClick);
    list.removeEventListener("keydown", onKey);
  };
}

function mountPager(root: HTMLElement): () => void {
  const slides = [...root.querySelectorAll<HTMLElement>(".proof-slide")];
  let i = 0;
  const show = (n: number) => {
    i = (n + slides.length) % slides.length;
    slides.forEach((s, j) => (s.hidden = j !== i));
    (root.querySelector("#proof-n") as HTMLElement).textContent = `0${i + 1} / 0${slides.length}`;
  };
  const prev = () => show(i - 1);
  const next = () => show(i + 1);
  const p = root.querySelector("#proof-prev") as HTMLElement;
  const n = root.querySelector("#proof-next") as HTMLElement;
  p.addEventListener("click", prev);
  n.addEventListener("click", next);
  return () => {
    p.removeEventListener("click", prev);
    n.removeEventListener("click", next);
  };
}

export async function mountLanding(root: HTMLElement): Promise<() => void> {
  root.innerHTML = VIEW;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
  let alive = true;
  const cleanups: (() => void)[] = [() => (alive = false), mountAsk($("ask"), { heading: false }), mountTabs(root), mountPager(root)];

  // The bundle is small and arrives before the engine is ready: the counts first.
  const bundle = await load<LendingBundle>(BUNDLE);
  const s = bundle.summary;
  cleanups.push(mountPipeline(root, s.positions));
  $("pipe-note").textContent = `One line for each of the ${s.positions.toLocaleString("en-US")} open positions on Monad's Morpho markets.`;
  const nums = root.querySelectorAll<HTMLElement>("#numbers .v");
  const set = (i: number, v: string) => nums[i] && (nums[i].textContent = v);
  set(0, s.markets.toLocaleString("en-US"));
  set(1, s.positions.toLocaleString("en-US"));
  set(2, usdM(s.debtIssuerMarksDownUsd));
  $("flow-block").textContent = `block ${bundle.manifest.blocks.to.toLocaleString("en-US")}`;

  const d: Lending = await loadLending();
  if (!alive) return () => cleanups.forEach((f) => f());
  const pm = (d.markets.find((m) => m.market.id === REPLAYED_MARKET) ?? d.markets[0]) as PreparedMarket;
  const story = storyOf(d, pm);
  const fact = d.facts.get(pm.market.id);
  const firstLoss = fact?.firstLoss ?? null;
  const quoted = d.prices.get(QUOTED_VAULT);

  // ---------------------------------------------------------------- the capabilities fragment
  $("flow-chips").innerHTML = d.markets
    .map((m) => `<span class="chip-file"><b>${pct(m.market.lltv)}</b><span><span class="n">${pair(m)}</span><span class="s">${usdShort(debtUsd(m))} borrowed</span></span></span>`)
    .join("");
  $("flow-first").textContent = firstLoss === null ? "No first loss up to 100%" : `First loss at ${pct(firstLoss)}`;

  // ---------------------------------------------------------------- the price card
  const rateText = quoted ? rate(quoted.premiumOnSupply) : "Not priced";
  const limitText = quoted ? usdShort(quoted.limitUsd) : "None";
  $("price-rate").textContent = rateText;
  $("price-limit").textContent = limitText;
  $("price-market").textContent = `${pair(pm)}, ${pct(mainVault(pm).share)} of it`;
  $("price-first").textContent = firstLoss === null ? "None" : pct(firstLoss);
  root.querySelectorAll<HTMLElement>("[data-fill=rate]").forEach((e) => (e.textContent = rateText));
  root.querySelectorAll<HTMLElement>("[data-fill=limit]").forEach((e) => (e.textContent = limitText));

  // ---------------------------------------------------------------- the flood picture
  const picture = new Picture();
  await picture.mount($("hero-canvas"));
  $("hero-loading").remove();
  cleanups.push(() => picture.destroy());

  const slider = $<HTMLInputElement>("hero-shock");
  let shock = 0;
  const draw = () => {
    if (!alive) return;
    const m = drawMarket(d, pm, shock, picture, $("hero-overlay"), $("hero-legend"));
    $("hero-stage").classList.toggle("loss", m.depositors > 0);
    $("hero-shock-value").textContent = pct(shock);
    slider.value = String(shock * 100);
    slider.style.setProperty("--fill", `${(shock / 0.4) * 100}%`);
  };
  const player = new Player(
    () => shock,
    (x) => {
      shock = Math.round(x * 2000) / 2000;
      draw();
    },
  );
  cleanups.push(() => player.stop());
  let touched = false;
  slider.addEventListener("input", () => {
    touched = true;
    player.stop();
    shock = Number(slider.value) / 100;
    draw();
  });

  if (player.reduced) {
    // A still of the story's end.
    shock = story[2] ?? 0.25;
    draw();
  } else {
    // Play the story only while it is on screen, until the visitor takes the slider.
    const seen = new IntersectionObserver(([e]) => {
      if (touched) return;
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
