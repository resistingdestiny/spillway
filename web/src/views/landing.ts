// The landing page: what Spillway does, how to use it, one worked example, three numbers, a note for
// those who back the cover, questions, and the way into the checker.

import "../landing.css";

import deployment from "../../../contracts/deployments/monad-testnet-lending.json";
import replay from "../../../contracts/replay/testnet-wstETH-WETH-unrealised-25.json";
import { DEFAULT_VAULT, type Book, dollars, dollarsShort, findVault, loadBook, percent, quote, yearly } from "../vaults.js";
import { REPO } from "./verify.js";

/** The worked example: a deposit, and the sudden drop the testnet replay used. */
const EXAMPLE_DEPOSIT = 10_000;
const EXAMPLE_DROP = 0.2;

const PAID = replay.onChain.paid.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CLAIM_TX = `${deployment.explorer}/tx/${deployment.events.claimShortfall}`;
const ext = `target="_blank" rel="noopener"`;
const ARROW = `<span aria-hidden="true">&rarr;</span>`;
const CHEVRON = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const img = (src: string, w: number, h: number, alt: string, cls = "", eager = false) =>
  `<img class="${cls}" src="${src}" width="${w}" height="${h}" alt="${alt}" ${eager ? `fetchpriority="high"` : `loading="lazy" decoding="async"`} />`;
const sk = (w: string) => `<span class="skeleton" style="width:${w}"></span>`;

const STEPS: [string, string, string, string][] = [
  ["Pick your vault", "Choose the Morpho vault your money is in.", "img/tokens.webp", "A stack of white tokens beside a pool of blue water"],
  ["See your risk and price", "We test every loan in it against a sudden drop and show what you would lose and what cover costs.", "img/gauge.webp", "A white gauge post standing in a pool of blue water"],
  ["Get paid if it happens", "If the vault takes a loss, cover pays you from on-chain data. No claim form, no vote.", "img/chute.webp", "A white chute carrying a ribbon of blue water"],
];

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
      <div class="wrap hero-wrap guides">
        <div class="eyebrow">Morpho vaults on Monad</div>
        <h1 class="h1" id="hero-h">Insurance for your Monad lending deposits</h1>
        <p class="hero-sub">See what a sudden crash would cost your vault, and cover it. Claims pay out automatically.</p>
        <div class="cta-row">
          <a class="btn" href="#/check">Check your vault</a>
          <a class="btn outline" href="#/" data-scroll="how">How it works</a>
        </div>
      </div>
      <div class="wrap hero-art">
        ${img("img/dam.webp", 1536, 640, "A white clay dam holding a blue reservoir, with water running down its spillway", "hero-img", true)}
      </div>
    </section>

    <section class="how" aria-labelledby="how-h" id="sec-how">
      <div class="wrap sec-top center">
        <div class="eyebrow">How it works</div>
        <h2 class="h2" id="how-h">Three steps to cover</h2>
      </div>
      <ol class="wrap steps3">
        ${STEPS.map(([t, p, src, alt], i) => `<li class="step-card"><span class="step-n">0${i + 1}</span>${img(src, 640, 640, alt, "spot")}<h3 class="h4">${t}</h3><p>${p}</p></li>`).join("")}
      </ol>
      <div class="wrap center sec-cta"><a class="btn" href="#/check">Check your vault</a></div>
    </section>

    <section class="band dark example" aria-labelledby="ex-h" id="sec-example">
      <div class="wrap band-wrap">
        <div class="eyebrow light">An example</div>
        <h2 class="h2" id="ex-h">What cover does in a crash</h2>
        <div class="ex" id="ex">
          <div class="ex-copy" aria-live="polite">
            <span class="ex-n" id="ex-n">Step 1 of 4</span>
            <p class="ex-text" id="ex-text">${sk("80%")}</p>
            <div class="ex-big" id="ex-big">${sk("3em")}</div>
            <p class="ex-note" id="ex-note"></p>
            <p class="ex-proof" id="ex-proof" hidden>This ran for real on Monad testnet: ${PAID} tUSD paid in one transaction. <a href="${CLAIM_TX}" ${ext}>View it on Monadscan ${ARROW}</a></p>
          </div>
          <div class="ex-visual" aria-hidden="true">
            <div class="ex-bar"><i class="ex-loss" id="ex-loss"></i><i class="ex-paid" id="ex-paid"></i></div>
            <div class="ex-legend"><span class="d">Your deposit</span><span class="l">Loss</span><span class="p">Paid by cover</span></div>
          </div>
        </div>
        <div class="ex-nav">
          <button type="button" class="btn light outline-light" id="ex-back">Back</button>
          <span class="ex-dots" id="ex-dots">${"<i></i>".repeat(4)}</span>
          <button type="button" class="btn light" id="ex-next">Next</button>
        </div>
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

interface Slide {
  text: string;
  big: string;
  note: string;
  loss: number;
  paid: number;
  /** Show the testnet payout under it. */
  proof?: boolean;
}

function slides(book: Book): Slide[] {
  const v = findVault(book, DEFAULT_VAULT);
  const t = v.tokens[0];
  if (!t) return [];
  const q = quote(book, v, t, EXAMPLE_DROP, EXAMPLE_DEPOSIT);
  const capped = q.payout < q.yourLoss - 0.5;
  return [
    { text: `You deposit ${dollars(EXAMPLE_DEPOSIT)} in ${v.name}.`, big: dollars(EXAMPLE_DEPOSIT), note: "Your deposit earns interest from the vault's loans.", loss: 0, paid: 0 },
    {
      text: `You add cover for ${dollars(q.premium ?? 0)} a year.`,
      big: `${dollars(q.premium ?? 0)}<small>a year</small>`,
      note: `That is ${yearly(v.rate ?? 0)} of your deposit.`,
      loss: 0,
      paid: 0,
    },
    {
      text: `${t.symbol} suddenly drops ${percent(EXAMPLE_DROP, 0)}. Some loans go bad and the vault loses ${percent(q.share)}.`,
      big: `−${dollars(q.yourLoss)}`,
      note: "Your share of the vault's loss.",
      loss: q.share,
      paid: 0,
    },
    {
      text: `Spillway pays you ${dollars(q.payout)} automatically.`,
      big: dollars(q.payout),
      note: capped ? `That is the most cover pays on your deposit, ${dollars(q.yourLimit)}.` : "Your whole share of the loss.",
      proof: true,
      loss: q.share,
      paid: q.payout / EXAMPLE_DEPOSIT,
    },
  ];
}

/** Next and Back through the example, with a slow auto-play that stops on the first click. */
function mountExample(root: HTMLElement, list: Slide[]): () => void {
  const $ = (id: string) => root.querySelector(`#${id}`) as HTMLElement;
  let i = 0;
  const show = (n: number) => {
    i = Math.max(0, Math.min(list.length - 1, n));
    const s = list[i] as Slide;
    $("ex-n").textContent = `Step ${i + 1} of ${list.length}`;
    $("ex-text").textContent = s.text;
    $("ex-big").innerHTML = s.big;
    $("ex-note").textContent = s.note;
    $("ex-proof").hidden = !s.proof;
    $("ex-loss").style.width = `${s.loss * 100}%`;
    $("ex-paid").style.width = `${s.paid * 100}%`;
    root.querySelectorAll("#ex-dots i").forEach((d, j) => d.classList.toggle("on", j <= i));
    ($("ex-back") as HTMLButtonElement).disabled = i === 0;
    $("ex-next").textContent = i === list.length - 1 ? "Start again" : "Next";
  };
  let timer = 0;
  let touched = false;
  const stop = () => clearInterval(timer);
  // Plays only while the band is on screen, and never with reduced motion.
  const seen = new IntersectionObserver(([e]) => {
    stop();
    if (e?.isIntersecting && !touched) timer = window.setInterval(() => show((i + 1) % list.length), 5000);
  });
  if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) seen.observe($("ex"));
  const touch = () => ((touched = true), stop());
  $("ex-back").addEventListener("click", () => (touch(), show(i - 1)));
  $("ex-next").addEventListener("click", () => (touch(), show(i === list.length - 1 ? 0 : i + 1)));
  $("ex").addEventListener("click", touch);
  show(0);
  return () => {
    stop();
    seen.disconnect();
  };
}

export async function mountLanding(root: HTMLElement): Promise<() => void> {
  root.innerHTML = VIEW;
  const cleanups: (() => void)[] = [];
  const onAsk = (e: Event) => (e.target as HTMLElement).closest("[data-ask]") && document.querySelector<HTMLButtonElement>(".ask-fab")?.click();
  root.addEventListener("click", onAsk);
  cleanups.push(() => root.removeEventListener("click", onAsk));

  const book = await loadBook();
  const s = book.bundle.summary;
  const nums = root.querySelectorAll<HTMLElement>("#numbers .v");
  const set = (i: number, v: string) => nums[i] && (nums[i].textContent = v);
  set(0, book.bundle.vaults.length.toLocaleString("en-US"));
  set(1, dollarsShort(s.supplyUsd));
  set(2, s.borrowers.toLocaleString("en-US"));
  cleanups.push(mountExample(root, slides(book)));
  return () => cleanups.forEach((f) => f());
}
