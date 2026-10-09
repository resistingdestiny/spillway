// The landscape under the headline: one clay object for each of the biggest vaults, the dam for the
// default one. Each object is a button; its card shows what the vault holds, where it first loses
// money, what cover costs and a link into the checker. Cycles through the vaults on its own until
// the visitor points at, focuses or clicks one.

import { type Book, DEFAULT_VAULT, type Vault, dollarsShort, escapeHtml, findVault, firstLoss, percent, riskLevel, yearly } from "../vaults.js";

interface Sprite {
  file: string;
  /** Left, top and width in stage units (the stage is 1200 by 500), and the image's own aspect. */
  x: number;
  y: number;
  w: number;
  aspect: number;
  /** Where the card points, in stage units. */
  ax: number;
  ay: number;
}

const DAM: Sprite = { file: "dam", x: 372, y: 168, w: 456, aspect: 500 / 1200, ax: 720, ay: 214 };
/** The other vaults, biggest first, take these in turn. */
const OTHERS: Sprite[] = [
  { file: "tanks", x: 112, y: 214, w: 214, aspect: 557 / 640, ax: 248, ay: 250 },
  { file: "reservoir", x: 846, y: 150, w: 176, aspect: 529 / 640, ax: 880, ay: 190 },
  { file: "pump-house", x: 1010, y: 248, w: 156, aspect: 598 / 600, ax: 1060, ay: 290 },
  { file: "water-tower", x: 300, y: 62, w: 98, aspect: 1005 / 520, ax: 376, ay: 150 },
  { file: "lock", x: 24, y: 384, w: 236, aspect: 317 / 760, ax: 200, ay: 410 },
  { file: "sluice", x: 852, y: 330, w: 118, aspect: 596 / 560, ax: 880, ay: 370 },
];
const CLOUDS: [number, number, number][] = [
  [150, 40, 92],
  [470, 70, 70],
  [760, 22, 84],
  [1040, 84, 74],
];
const BIRDS: [number, number][] = [
  [640, 118],
  [664, 106],
  [954, 150],
  [978, 142],
  [214, 152],
];

const pct = (n: number, of: number) => `${((n / of) * 100).toFixed(3)}%`;
const BIRD = `<svg viewBox="0 0 20 8" aria-hidden="true"><path d="M1 6c3-4 6-4 9 0c3-4 6-4 9 0" fill="none" stroke="#9aa6b3" stroke-width="1.3" stroke-linecap="round"/></svg>`;
const RIVER = `<svg class="land-ground" viewBox="0 0 1200 500" preserveAspectRatio="none" aria-hidden="true">
  <defs>
    <radialGradient id="land-g" cx="50%" cy="72%" r="62%"><stop offset="0" stop-color="#eef2f6"/><stop offset="0.7" stop-color="#f4f7fa"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="land-w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bcd8f0"/><stop offset="1" stop-color="#d9eaf8" stop-opacity="0.2"/></linearGradient>
  </defs>
  <ellipse cx="600" cy="400" rx="640" ry="150" fill="url(#land-g)"/>
  <path class="land-river" d="M560 372c-30 30 40 50 10 80s-80 30-60 60h120c-10-30 60-40 50-70s-60-50-40-70z" fill="url(#land-w)"/>
</svg>`;

/** Sprite and vault pairs: the default vault on the dam, the next six by deposits around it. */
function cast(book: Book): [Sprite, Vault][] {
  const dam = findVault(book, DEFAULT_VAULT);
  const rest = book.vaults.filter((v) => v !== dam).slice(0, OTHERS.length);
  return [[DAM, dam] as [Sprite, Vault], ...rest.map((v, i) => [OTHERS[i] as Sprite, v] as [Sprite, Vault])];
}

function card(book: Book, v: Vault): string {
  const t = v.tokens[0];
  const first = t ? firstLoss(book, t) : null;
  const level = v.rate === null ? null : riskLevel(v.rate);
  return `<p class="hc-name">${escapeHtml(v.name)}</p>
    <ul class="hc-facts">
      <li>${dollarsShort(v.depositsUsd)} deposits</li>
      ${t ? `<li>Lends against ${escapeHtml(t.symbol)}</li>` : ""}
      <li>${first === null ? "No loss in any drop tested" : `First loss at a ${percent(first, 0)} drop`}</li>
      <li>${v.rate === null ? "Not priced" : `Cover ${yearly(v.rate)} a year`}</li>
    </ul>
    ${level ? `<span class="hc-badge ${level}">${level} risk</span>` : ""}
    <a class="hc-act" href="#/check?vault=${v.address}">Check this vault <span aria-hidden="true">&rarr;</span></a>`;
}

/** The landscape's markup, before the data arrives: the ground, clouds and birds. */
export const LAND = `<div class="land" id="land"><div class="land-stage" id="land-stage">${RIVER}${CLOUDS.map(
  ([x, y, w], i) => `<img class="land-cloud c${i}" src="img/hero/cloud.webp" alt="" aria-hidden="true" width="300" height="189" style="left:${pct(x, 1200)};top:${pct(y, 500)};width:${pct(w, 1200)}" />`,
).join("")}${BIRDS.map(([x, y]) => `<i class="land-bird" style="left:${pct(x, 1200)};top:${pct(y, 500)}">${BIRD}</i>`).join("")}<div class="hcard" id="hcard" role="group" hidden></div></div></div>`;

const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function mountLand(root: HTMLElement, book: Book): () => void {
  const stage = root.querySelector("#land-stage") as HTMLElement;
  const box = root.querySelector("#hcard") as HTMLElement;
  const pairs = cast(book);
  stage.insertAdjacentHTML(
    "beforeend",
    pairs
      .map(([s, v], i) => {
        const src = `img/hero/${s.file}.webp`;
        const h = s.w * s.aspect;
        return `<button type="button" class="spr" data-i="${i}" aria-label="${escapeHtml(v.name)}, see its risk" aria-expanded="false" aria-controls="hcard" style="left:${pct(s.x, 1200)};top:${pct(s.y, 500)};width:${pct(s.w, 1200)};height:${pct(h, 500)};z-index:${Math.round(s.y + h)}"><img src="${src}" alt="" draggable="false" /><span class="tint" aria-hidden="true" style="-webkit-mask-image:url(${src});mask-image:url(${src})"></span></button>`;
      })
      .join(""),
  );
  const buttons = [...stage.querySelectorAll<HTMLButtonElement>("button.spr")];
  // A missing picture takes its button with it; the headline and buttons above never depend on them.
  let open = -1;
  function show(i: number): void {
    open = i;
    buttons.forEach((b, j) => {
      b.classList.toggle("on", j === i);
      b.setAttribute("aria-expanded", String(j === i));
    });
    if (i < 0) return void (box.hidden = true);
    const [s, v] = pairs[i] as [Sprite, Vault];
    box.innerHTML = card(book, v);
    box.setAttribute("aria-label", v.name);
    // Beside the object, on the side with more room, so it never covers the headline or buttons.
    box.style.setProperty("--x", `${((s.ax / 1200) * 100).toFixed(2)}%`);
    box.style.setProperty("--y", `${((s.ay / 500) * 100).toFixed(2)}%`);
    box.dataset.side = s.ax <= 760 ? "right" : "left";
    box.hidden = false;
    // Next in tab order after its button, so the link is one Tab away.
    buttons[i]?.after(box);
  }

  const lost = (img: HTMLImageElement | null, gone: () => void) => {
    if (!img) return;
    if (img.complete && img.naturalWidth === 0) gone();
    else img.addEventListener("error", gone);
  };
  stage.querySelectorAll<HTMLImageElement>(".land-cloud").forEach((img) => lost(img, () => img.remove()));
  buttons.forEach((b, i) =>
    lost(b.querySelector("img"), () => {
      b.hidden = true;
      if (open === i) show(-1);
    }),
  );
  /** The next object still on show after `i`, or -1 if none is. */
  const next = (i: number) => {
    for (let k = 1; k <= buttons.length; k++) {
      const j = (i + k) % buttons.length;
      if (!buttons[j]?.hidden) return j;
    }
    return -1;
  };

  let timer = 0;
  let still = false;
  const stop = () => ((still = true), clearInterval(timer));
  const start = () => {
    clearInterval(timer);
    if (still || reduced()) return;
    timer = window.setInterval(() => show(next(open)), 4000);
  };
  // Cycles only while the landscape is on screen.
  const seen = new IntersectionObserver(([e]) => (e?.isIntersecting ? start() : clearInterval(timer)));
  seen.observe(stage);

  const land = root.querySelector("#land") as HTMLElement;
  const onClick = (e: Event) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.spr");
    if (!b) return;
    stop();
    const i = Number(b.dataset.i);
    show(open === i && !box.hidden ? -1 : i);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || open < 0) return;
    const b = buttons[open];
    show(-1);
    b?.focus({ preventScroll: true });
  };
  land.addEventListener("click", onClick);
  const onOver = (e: Event) => (e.target as HTMLElement).closest("button.spr, .hcard") && stop();
  land.addEventListener("pointerover", onOver);
  land.addEventListener("focusin", stop);
  land.addEventListener("keydown", onKey);
  show(next(-1));
  start();
  return () => {
    clearInterval(timer);
    seen.disconnect();
  };
}
