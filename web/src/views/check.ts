// Check a vault: pick a vault and see it as its clay object with its card, see what a sudden drop in
// its collateral would cost, see what cover costs, and try the live cover on Monad testnet. The
// testnet payout, the verify facts and the flood picture of the vault's biggest market open in a
// drawer at #/check/proof, /verify and /loans.

import "../check.css";

import { setAskContext } from "../ask.js";
import { drawCurve } from "../chart.js";
import { cast, objectOf } from "../landscape.js";
import {
  type Book,
  DEFAULT_VAULT,
  HIGH_RATE,
  MAX_DROP,
  type TokenCurve,
  type Vault,
  dollars,
  dollarsShort,
  escapeHtml,
  findVault,
  fullyPaidUpTo,
  loadBook,
  lossAt,
  percent,
  quote,
  yearly,
} from "../vaults.js";
import { FOOTER, onFooterAsk } from "./footer.js";
import { vaultCard } from "./hero.js";
import { onCopy, verifyFacts } from "./verify.js";

const CLOSE = `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const CARET = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const icon = (d: string) => `<svg class="more-icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</g></svg>`;
/** Each drawer's overline and title. */
const DRAWERS = {
  loans: ["Stress test", "Every loan in the biggest market"],
  proof: ["Monad testnet", "Paid on Monad testnet"],
  verify: ["Proof", "How we know"],
} as const;
type Drawer = keyof typeof DRAWERS;
const MORE: [Drawer, string, string, string][] = [
  ["loans", "See every loan", "Each loan in this vault's biggest market, drawn as ledges.", `<path d="M4 4v16h16"/><path d="M4 8h7M4 12h10M4 16h5"/>`],
  ["proof", "Testnet payout", "The claim our cover has already paid on Monad testnet.", `<circle cx="12" cy="12" r="8"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>`],
  ["verify", "How we know", "The data, hashes and commands behind every number.", `<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/>`],
];
const sk = (w: string) => `<span class="skeleton" style="width:${w}"></span>`;
const stepHead = (n: number, title: string, id: string, line: string) => `<div class="ss cstep-head"><span class="ss-n">0${n}</span><h2 class="h4" id="${id}">${title}</h2><p>${line}</p></div>`;

const VIEW = `
  <div class="check">
    <section class="wrap guides center check-head" aria-labelledby="check-h">
      <div class="eyebrow">Check a vault</div>
      <h1 class="h1" id="check-h">What would a crash cost you?</h1>
      <p class="hero-sub">Pick the Morpho vault your money is in to see what a sudden price drop would cost and what cover costs.</p>
    </section>

    <section class="wrap pick-sec" aria-label="Your vault">
      <div class="picker" id="picker">
        <button type="button" class="picked" id="picked" aria-haspopup="listbox" aria-expanded="false">${sk("60%")}</button>
        <div class="pick-pop" id="pick-pop" hidden>
          <input type="search" id="pick-q" placeholder="Search vaults or curators" aria-label="Search vaults" autocomplete="off" />
          <ul role="listbox" id="pick-list" aria-label="Vaults"></ul>
        </div>
      </div>
      <div class="quick" id="quick" role="group" aria-label="The biggest vaults"></div>
      <div class="vstage" id="vstage">
        <figure class="vobj"><img id="v-img" alt="" width="520" height="300" /></figure>
        <div class="hcard vcard" id="v-card" role="group"></div>
      </div>
    </section>

    <section class="wrap cstep" aria-labelledby="s1">
      ${stepHead(1, "Your risk", "s1", "We test every loan in this vault against a sudden price drop.")}
      <div class="cstep-body risk">
        <label class="ask-line" for="drop">What if <b id="token-name">${sk("3em")}</b> suddenly drops <b id="drop-v">25%</b>?</label>
        <input type="range" id="drop" min="0" max="${MAX_DROP * 100}" step="1" value="20" />
        <div class="scale" aria-hidden="true"><span>0%</span><span>10%</span><span>20%</span><span>30%</span><span>40%</span><span>50%</span></div>
        <div class="token-pick" id="token-pick" hidden><span class="muted">Collateral in this vault:</span><div class="chips" id="tokens" role="group" aria-label="Collateral"></div></div>
        <label class="deposit">Your deposit <span class="money"><span aria-hidden="true">$</span><input type="number" id="deposit" min="0" step="100" inputmode="numeric" value="10000" aria-label="Your deposit in dollars" /></span></label>
        <div class="numbers cnums" aria-live="polite">
          <div class="num"><span class="v" id="r-vault">${sk("3em")}</span><span class="k">this vault would lose</span></div>
          <div class="num"><span class="v" id="r-share">${sk("2em")}</span><span class="k">of deposits</span></div>
          <div class="num mine"><span class="v" id="r-mine">${sk("3em")}</span><span class="k" id="r-mine-k">your $10,000 would lose</span></div>
        </div>
        <p class="note" id="r-note"></p>
        <figure class="curve">
          <figcaption class="muted">Loss as a share of deposits, by price drop</figcaption>
          <div id="curve"></div>
        </figure>
      </div>
    </section>

    <section class="wrap cstep" aria-labelledby="s2">
      ${stepHead(2, "Cover", "s2", "Cover pays your share of a loss automatically, from on-chain data.")}
      <div class="cstep-body cover">
        <div class="cover-top">
          <div class="cover-price"><span class="v" id="c-rate">${sk("3em")}</span><span class="k">of your deposit a year</span></div>
          <div class="stamp c-stamp" id="c-stamp" aria-hidden="true" hidden></div>
        </div>
        <dl class="rows" id="c-rows"></dl>
        <p class="note" id="c-high" hidden>High because this vault lends against collateral that has failed often or is hard to sell.</p>
      </div>
    </section>

    <section class="band dark tband" aria-labelledby="s3">
      <div class="wrap band-wrap cstep">
        ${stepHead(3, "Try it on testnet", "s3", "Try the whole flow on Monad testnet with free test dollars.")}
        <div class="cstep-body">
          <div class="testnet" id="live"></div>
          <p class="elsewhere" id="elsewhere" hidden>The testnet cover runs on ${DEFAULT_VAULT}'s loans. <button type="button" class="btn light small" id="to-default">Switch to ${DEFAULT_VAULT}</button></p>
        </div>
      </div>
    </section>

    <nav class="wrap more-grid" aria-label="More">
      ${MORE.map(([k, h, p, d]) => `<a class="more-card" href="#/check/${k}">${icon(d)}<span class="more-h">${h}</span><span class="more-p">${p}</span><span class="more-go" aria-hidden="true">&rarr;</span></a>`).join("")}
    </nav>
    ${FOOTER}

    <dialog class="drawer" id="drawer" aria-labelledby="drawer-h">
      <div class="drawer-head"><div><div class="eyebrow" id="drawer-o"></div><h2 class="h3" id="drawer-h"></h2></div><button type="button" class="close" id="drawer-close" aria-label="Close">${CLOSE}</button></div>
      <div class="drawer-body" id="drawer-loans"></div>
      <div class="drawer-body" id="drawer-proof"></div>
      <div class="drawer-body" id="drawer-verify"><p class="explain">${sk("70%")}</p></div>
    </dialog>
  </div>`;

const drawerOf = (): Drawer | null => {
  const sub = location.hash.replace(/^#\/?/, "").split(/[/?]/)[1] ?? "";
  return sub in DRAWERS ? (sub as Drawer) : null;
};

export async function mountCheck(root: HTMLElement): Promise<() => void> {
  root.innerHTML = VIEW;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
  const cleanups: (() => void)[] = [onCopy(root), onFooterAsk(root)];
  const on = <K extends keyof WindowEventMap>(el: EventTarget, type: K, fn: (e: WindowEventMap[K]) => void) => {
    el.addEventListener(type, fn as EventListener);
    cleanups.push(() => el.removeEventListener(type, fn as EventListener));
  };

  const book: Book = await loadBook();
  // The landing page links here as #/check?vault=<address>.
  const asked = new URLSearchParams(location.hash.split("?")[1] ?? "").get("vault")?.toLowerCase();
  let vault: Vault = book.vaults.find((v) => v.address.toLowerCase() === asked) ?? findVault(book, DEFAULT_VAULT);
  let token: TokenCurve = vault.tokens[0] as TokenCurve;
  let drop = 0.2;
  let deposit = 10_000;
  setAskContext(() => vault.name);

  // ---------------------------------------------------------------- the drawer
  const dialog = $<HTMLDialogElement>("drawer");
  let verifyLoaded = false;
  let loans: { draw: (v: Vault, drop: number) => void; destroy: () => void } | null = null;
  function openDrawer(which: Drawer | null): void {
    if (!which) return void (dialog.open && dialog.close());
    [$("drawer-o").textContent, $("drawer-h").textContent] = DRAWERS[which];
    for (const k of Object.keys(DRAWERS)) $(`drawer-${k}`).hidden = k !== which;
    if (which === "verify" && !verifyLoaded) {
      verifyLoaded = true;
      verifyFacts()
        .then((html) => ($("drawer-verify").innerHTML = html))
        .catch(() => ((verifyLoaded = false), ($("drawer-verify").innerHTML = `<p class="explain">The data did not arrive. Close and try again.</p>`)));
    }
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    if (which === "loans") {
      if (!loans) {
        $("drawer-loans").innerHTML = `<p class="explain">Running the stress test in your browser</p>`;
        import("./loans.js")
          .then((m) => m.mountLoans($("drawer-loans")))
          .then((l) => ((loans = l), cleanups.push(() => l.destroy()), l.draw(vault, drop)))
          .catch(() => ($("drawer-loans").innerHTML = `<p class="explain">The loans could not load. Close and try again.</p>`));
      } else loans.draw(vault, drop);
    }
  }
  on(dialog, "close", () => drawerOf() && history.replaceState(null, "", "#/check"));
  on(dialog, "click", (e) => e.target === dialog && dialog.close());
  on($("drawer-close"), "click", () => dialog.close());
  on(window, "hashchange", () => openDrawer(drawerOf()));

  // The live testnet cover fills step 4 and the proof drawer.
  import("./live.js")
    .then((m) => m.mountLive($("live"), $("drawer-proof")))
    .then((unmount) => cleanups.push(unmount))
    .catch(() => {
      $("live").innerHTML = `<p class="explain">Monad testnet could not be reached. Try again shortly.</p>`;
      $("drawer-proof").innerHTML = `<p class="explain">Monad testnet could not be reached. Try again shortly.</p>`;
    });

  // ---------------------------------------------------------------- the picker
  const pop = $("pick-pop");
  const q = $<HTMLInputElement>("pick-q");
  const row = (v: Vault) =>
    `<span class="pv-name">${escapeHtml(v.name)}</span><span class="pv-sub">${v.curator ? escapeHtml(v.curator) : "Curator not listed"}</span><span class="pv-dep">${dollarsShort(v.depositsUsd)}<small>deposits</small></span>`;
  function list(): void {
    const term = q.value.trim().toLowerCase();
    const hits = book.vaults.filter((v) => !term || v.name.toLowerCase().includes(term) || (v.curator ?? "").toLowerCase().includes(term));
    $("pick-list").innerHTML = hits.length
      ? hits.map((v) => `<li role="option" tabindex="-1" data-a="${v.address}" aria-selected="${v === vault}">${row(v)}</li>`).join("")
      : `<li class="none">No vault matches</li>`;
  }
  const setPop = (open: boolean) => {
    pop.hidden = !open;
    $("picked").setAttribute("aria-expanded", String(open));
    if (open) {
      q.value = "";
      list();
      q.focus();
    }
  };
  on($("picked"), "click", () => setPop(pop.hidden !== false));
  on(q, "input", list);
  on(q, "keydown", (e) => {
    if (e.key === "Escape") setPop(false);
    if (e.key === "ArrowDown") (e.preventDefault(), $("pick-list").querySelector<HTMLElement>("[role=option]")?.focus());
    if (e.key === "Enter") (e.preventDefault(), $("pick-list").querySelector<HTMLElement>("[role=option]")?.click());
  });
  on($("pick-list"), "keydown", (e) => {
    const li = document.activeElement as HTMLElement;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      ((e.key === "ArrowDown" ? li.nextElementSibling : li.previousElementSibling) as HTMLElement | null)?.focus();
    } else if (e.key === "Enter" || e.key === " ") (e.preventDefault(), li.click());
    else if (e.key === "Escape") setPop(false), $("picked").focus();
  });
  on($("pick-list"), "click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
    if (!li) return;
    choose(book.vaults.find((v) => v.address === li.dataset.a) as Vault);
    setPop(false);
    $("picked").focus();
  });
  on(document, "click", (e) => !pop.hidden && !$("picker").contains(e.target as Node) && setPop(false));

  // ---------------------------------------------------------------- the stage
  const pairs = cast(book);
  $("quick").innerHTML = pairs
    .map(([s, v]) => `<button type="button" class="qv" data-a="${v.address}" aria-pressed="false"><img src="img/hero/${s.file}.webp" alt="" loading="lazy" decoding="async" /><span>${escapeHtml(v.name)}</span></button>`)
    .join("");
  on($("quick"), "click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-a]");
    if (b) choose(book.vaults.find((v) => v.address === b.dataset.a) as Vault);
  });
  const still = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let shown: Vault | null = null;
  function stage(v: Vault): void {
    const img = $<HTMLImageElement>("v-img");
    const card = $("v-card");
    const file = objectOf(pairs, v).file;
    img.src = `img/hero/${file}.webp`;
    img.parentElement?.setAttribute("data-file", file);
    card.innerHTML = vaultCard(book, v, false);
    card.setAttribute("aria-label", v.name);
    root.querySelectorAll("#quick button").forEach((b) => b.setAttribute("aria-pressed", String((b as HTMLElement).dataset.a === v.address)));
    // A short fade when the visitor swaps vaults; none on the first draw or with reduced motion.
    if (shown && shown !== v && !still()) {
      for (const el of [img, card]) el.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "ease-out" });
    }
    shown = v;
  }

  function choose(v: Vault): void {
    vault = v;
    stage(v);
    token = v.tokens[0] as TokenCurve;
    $("picked").innerHTML = `${row(v)}<span class="pv-caret">${CARET}</span>`;
    $("token-pick").hidden = v.tokens.length < 2;
    $("tokens").innerHTML = v.tokens.map((t, i) => `<button type="button" data-i="${i}" aria-pressed="${i === 0}">${escapeHtml(t.symbol)}</button>`).join("");
    const isDefault = v.name === DEFAULT_VAULT;
    $("live").hidden = !isDefault;
    $("elsewhere").hidden = isDefault;
    draw();
  }
  on($("tokens"), "click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-i]");
    if (!b) return;
    token = vault.tokens[Number(b.dataset.i)] as TokenCurve;
    root.querySelectorAll("#tokens button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    draw();
  });
  on($("to-default"), "click", () => (choose(findVault(book, DEFAULT_VAULT)), $("s3").scrollIntoView({ block: "start" })));

  // ---------------------------------------------------------------- risk and cover
  const slider = $<HTMLInputElement>("drop");
  on(slider, "input", () => ((drop = Number(slider.value) / 100), draw()));
  on($("deposit"), "input", () => {
    const n = Number(($("deposit") as HTMLInputElement).value);
    deposit = Number.isFinite(n) && n > 0 ? n : 0;
    draw();
  });

  function draw(): void {
    const r = quote(book, vault, token, drop, deposit);
    $("token-name").textContent = token.symbol;
    $("drop-v").textContent = percent(drop, 0);
    slider.style.setProperty("--fill", `${(drop / MAX_DROP) * 100}%`);
    $("r-vault").textContent = dollarsShort(r.vaultLoss);
    $("r-share").textContent = percent(r.share);
    $("r-mine-k").textContent = `your ${dollars(deposit)} would lose`;
    $("r-mine").textContent = dollars(r.yourLoss);
    const worst = lossAt(book, token, MAX_DROP);
    $("r-note").textContent =
      worst <= 0
        ? `No loan in this vault goes bad, even if ${token.symbol} drops ${percent(MAX_DROP, 0)}.`
        : r.vaultLoss <= 0
          ? "Every loan's collateral still covers what was borrowed, so nobody loses yet."
          : "";

    const xs = book.shocks.filter((s) => s <= MAX_DROP + 1e-9);
    drawCurve($("curve"), { xs, ys: xs.map((s) => lossAt(book, token, s) / vault.depositsUsd), maxDrop: MAX_DROP, at: drop, atY: r.share });

    const priced = vault.rate !== null && vault.limitUsd > 0;
    $("c-rate").textContent = priced ? yearly(vault.rate as number) : "Not priced";
    const upTo = fullyPaidUpTo(book, vault, token);
    const dl = (k: string, v: string) => `<div class="row"><dt>${k}</dt><dd>${v}</dd></div>`;
    $("c-rows").innerHTML = priced
      ? dl(`Price on your ${dollars(deposit)}`, `${dollars(r.premium ?? 0)} a year`) +
        dl("Most it pays you", `${dollars(r.yourLimit)}<br><span class="muted">${dollarsShort(vault.limitUsd)} for the whole vault</span>`) +
        dl("Pays your whole loss", upTo >= 1 ? "in any drop" : `in drops up to ${percent(upTo, 0)}`) +
        dl(`At a ${percent(drop, 0)} drop it pays you`, `<b>${dollars(r.payout)}</b>`) +
        dl("How it pays", "Pays automatically from Morpho's on-chain data")
      : dl("Why", "Nothing in this vault can lose money in the test, so there is nothing to price.");
    const stamp = $("c-stamp");
    stamp.hidden = !priced || r.payout < 0.5;
    stamp.textContent = `Pays you ${dollars(r.payout)} at a ${percent(drop, 0)} drop`;
    $("c-high").hidden = !(priced && (vault.rate as number) > HIGH_RATE);
    if (loans && dialog.open && drawerOf() === "loans") loans.draw(vault, drop);
  }

  const resize = new ResizeObserver(() => requestAnimationFrame(draw));
  resize.observe($("curve"));
  cleanups.push(() => resize.disconnect());
  choose(vault);
  openDrawer(drawerOf());
  return () => {
    if (dialog.open) dialog.close();
    setAskContext(null);
    cleanups.forEach((f) => f());
  };
}
