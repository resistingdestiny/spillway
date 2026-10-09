// Check a vault: pick a vault, see what a sudden drop in its collateral would cost, see what cover
// costs, and try the live cover on Monad testnet. The testnet payout, the verify facts and the flood
// picture of the vault's biggest market open in a drawer at #/check/proof, /verify and /loans.

import "../check.css";

import { setAskContext } from "../ask.js";
import { drawCurve } from "../chart.js";
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
import { onCopy, verifyFacts } from "./verify.js";

const CLOSE = `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const CARET = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const DRAWERS = { loans: "Every loan in the biggest market", proof: "Paid on Monad testnet", verify: "How we know" } as const;
type Drawer = keyof typeof DRAWERS;
const sk = (w: string) => `<span class="skeleton" style="width:${w}"></span>`;
const stepHead = (n: number, title: string, id: string) => `<h2 class="step-h" id="${id}"><span class="step-num">${n}</span>${title}</h2>`;

const VIEW = `
  <div class="check">
    <div class="check-top">
      <div class="eyebrow">Check a vault</div>
      <h1 class="h2">What would a crash cost you?</h1>
      <p class="check-sub">Pick the Morpho vault your money is in. We show what a sudden price drop would cost and what cover costs.</p>
    </div>

    <section class="panel" aria-labelledby="s1">
      ${stepHead(1, "Pick your vault", "s1")}
      <div class="picker" id="picker">
        <button type="button" class="picked" id="picked" aria-haspopup="listbox" aria-expanded="false">${sk("60%")}</button>
        <div class="pick-pop" id="pick-pop" hidden>
          <input type="search" id="pick-q" placeholder="Search vaults or curators" aria-label="Search vaults" autocomplete="off" />
          <ul role="listbox" id="pick-list" aria-label="Vaults"></ul>
        </div>
      </div>
    </section>

    <section class="panel" aria-labelledby="s2">
      ${stepHead(2, "Your risk", "s2")}
      <div class="risk">
        <div>
          <label class="ask-line" for="drop">What if <b id="token-name">${sk("3em")}</b> suddenly drops <b id="drop-v">25%</b>?</label>
          <input type="range" id="drop" min="0" max="${MAX_DROP * 100}" step="1" value="20" />
          <div class="scale" aria-hidden="true"><span>0%</span><span>10%</span><span>20%</span><span>30%</span><span>40%</span><span>50%</span></div>
          <div class="token-pick" id="token-pick" hidden><span class="muted">Collateral in this vault:</span><div class="chips" id="tokens" role="group" aria-label="Collateral"></div></div>
          <label class="deposit">Your deposit <span class="money"><span aria-hidden="true">$</span><input type="number" id="deposit" min="0" step="100" inputmode="numeric" value="10000" aria-label="Your deposit in dollars" /></span></label>
          <div class="results" aria-live="polite">
            <div class="res"><span class="k">This vault would lose</span><span class="v" id="r-vault">${sk("3em")}</span></div>
            <div class="res"><span class="k">That is</span><span class="v" id="r-share">${sk("2em")}</span><span class="k">of deposits</span></div>
            <div class="res mine"><span class="k" id="r-mine-k">Your $10,000 would lose</span><span class="v" id="r-mine">${sk("3em")}</span></div>
          </div>
          <p class="note" id="r-note"></p>
        </div>
        <figure class="curve">
          <figcaption class="muted">Loss as a share of deposits, by price drop</figcaption>
          <div id="curve"></div>
        </figure>
      </div>
    </section>

    <section class="panel" aria-labelledby="s3">
      ${stepHead(3, "Cover for this vault", "s3")}
      <div class="cover">
        <div class="cover-price"><span class="v" id="c-rate">${sk("3em")}</span><span class="k">of your deposit a year</span></div>
        <dl class="rows" id="c-rows"></dl>
        <p class="note" id="c-high" hidden>High because this vault lends against collateral that has failed often or is hard to sell.</p>
      </div>
    </section>

    <section class="panel" aria-labelledby="s4">
      ${stepHead(4, "Try it on testnet", "s4")}
      <div class="testnet" id="live"></div>
      <p class="elsewhere" id="elsewhere" hidden>The testnet cover runs on ${DEFAULT_VAULT}'s loans. <button type="button" class="btn outline small" id="to-default">Switch to ${DEFAULT_VAULT}</button></p>
    </section>

    <nav class="check-links" aria-label="More">
      <a href="#/check/loans">See every loan</a>
      <a href="#/check/proof">Testnet payout</a>
      <a href="#/check/verify">How we know</a>
    </nav>

    <dialog class="drawer" id="drawer" aria-labelledby="drawer-h">
      <div class="drawer-head"><h2 class="section" id="drawer-h"></h2><button type="button" class="close" id="drawer-close" aria-label="Close">${CLOSE}</button></div>
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
  const cleanups: (() => void)[] = [onCopy(root)];
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
    $("drawer-h").textContent = DRAWERS[which];
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

  function choose(v: Vault): void {
    vault = v;
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
  on($("to-default"), "click", () => (choose(findVault(book, DEFAULT_VAULT)), $("s4").scrollIntoView({ block: "start" })));

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
    $("r-mine-k").textContent = `Your ${dollars(deposit)} would lose`;
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
