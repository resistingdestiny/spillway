// How it works, told inside the hero. On wide screens the hero is a tall section with a pinned
// stage: as it scrolls the landscape drops away, ribbons of water rise, a small copy of the checker
// rises into the centre and plays one check, then the three steps settle around it. On phones and
// with reduced motion nothing is pinned: the window plays once when it comes into view, or shows
// its end state, and the steps follow as a list.

import type { Book, TokenCurve } from "../vaults.js";
import type * as Vaults from "../vaults.js";

/** The vault helpers, handed in by the landing page so this chunk loads nothing else. */
export type Kit = Pick<typeof Vaults, "DEFAULT_VAULT" | "MAX_DROP" | "dollars" | "dollarsShort" | "escapeHtml" | "findVault" | "percent" | "quote">;

/** The check the window plays: the deposit and the sudden drop it slides to. */
const DEPOSIT = 10_000;
const DROP = 0.2;

const STEPS: [string, string][] = [
  ["Pick your vault", "Choose the Morpho vault your money is in."],
  ["See your risk and price", "We test every loan in it against a sudden drop and show what you would lose and what cover costs."],
  ["Get paid if it happens", "If the vault takes a loss, cover pays you from on-chain data. No claim form, no vote."],
];
const sk = (w: string) => `<span class="skeleton" style="width:${w}"></span>`;
const step = (n: number, h: string) => `<h3 class="step-h"><span class="step-num">${n}</span>${h}</h3>`;

/** The story's markup; `proof` goes under the last step. */
export const storyHtml = (proof: string, { dollars }: Kit) => `
  <div class="story" id="story">
    <div class="story-head"><div class="eyebrow">How it works</div><h2 class="h2" id="how-h">Three steps to cover</h2></div>
    <div class="pw" id="pw" aria-label="The checker, playing one check" role="img">
      <div class="pw-in" id="pw-in" aria-hidden="true">
        <div class="pw-bar"><i></i><i></i><i></i><span class="pw-url">spillway / check</span></div>
        <div class="pw-body">
          <div class="panel">${step(1, "Pick your vault")}<div class="picked pw-picked" id="pw-picked">${sk("60%")}</div></div>
          <div class="panel">${step(2, "Your risk")}
            <p class="ask-line">What if <b id="pw-token">${sk("3em")}</b> suddenly drops <b id="pw-drop">0%</b>?</p>
            <div class="pw-range"><i class="pw-fill" id="pw-fill"></i><i class="pw-thumb" id="pw-thumb"></i></div>
            <div class="scale"><span>0%</span><span>10%</span><span>20%</span><span>30%</span><span>40%</span><span>50%</span></div>
            <div class="results">
              <div class="res"><span class="k">This vault would lose</span><span class="v" id="pw-vault">$0</span></div>
              <div class="res"><span class="k">That is</span><span class="v" id="pw-share">0%</span><span class="k">of deposits</span></div>
              <div class="res mine" id="pw-mine"><span class="k">Your ${dollars(DEPOSIT)} would lose</span><span class="v" id="pw-loss">${sk("3em")}</span></div>
            </div>
          </div>
          <div class="panel pw-cover" id="pw-cover">${step(3, "Cover for this vault")}<div class="cover-price"><span class="v" id="pw-premium">${sk("3em")}</span><span class="k">a year on your ${dollars(DEPOSIT)}</span></div></div>
        </div>
        <div class="pw-stamp" id="pw-stamp">${sk("6em")}</div>
      </div>
    </div>
    <ol class="story-steps">${STEPS.map(([h, p], i) => `<li class="ss ss${i + 1}"><span class="ss-n">0${i + 1}</span><h3 class="h4">${h}</h3><p>${p}</p>${i === 2 ? proof : ""}</li>`).join("")}</ol>
    <div class="story-cta"><a class="btn" href="#/check">Check your vault</a></div>
  </div>`;

const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const seg = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** Two bundles of thin lines, water blues with one lime thread, rising with `rise` from 0 to 1. */
function drawRibbons(ctx: CanvasRenderingContext2D, W: number, H: number, rise: number, flow: number): void {
  ctx.clearRect(0, 0, W, H);
  if (rise <= 0) return;
  const lift = (1 - ease(rise)) * H * 0.5;
  const bundles = [
    { x0: -0.05, y0: 0.98, x1: 0.5, y1: 0.56, c: [31, 95, 214], n: 64, spread: 0.22, lime: 44 },
    { x0: 0.5, y0: 0.52, x1: 1.05, y1: 0.3, c: [93, 150, 240], n: 56, spread: 0.26, lime: -1 },
  ];
  for (const b of bundles) {
    for (let i = 0; i < b.n; i++) {
      const k = i / (b.n - 1);
      const wave = Math.sin(flow * 3 + k * 2.4) * H * 0.025;
      const y0 = b.y0 * H + lift + k * b.spread * H * 0.9;
      const y1 = b.y1 * H + lift + k * b.spread * H * 0.35;
      const x0 = b.x0 * W;
      const x1 = b.x1 * W;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(lerp(x0, x1, 0.4), y0 - H * 0.04 + wave, lerp(x0, x1, 0.62), y1 + H * 0.08 - wave, x1, y1);
      const edge = Math.sin(k * Math.PI);
      if (i === b.lime) {
        ctx.strokeStyle = `rgba(198, 244, 50, ${0.95 * rise})`;
        ctx.lineWidth = 1.6;
      } else {
        ctx.strokeStyle = `rgba(${b.c[0]}, ${b.c[1]}, ${b.c[2]}, ${(0.1 + 0.5 * edge * edge) * rise})`;
        ctx.lineWidth = 1;
      }
      ctx.stroke();
    }
  }
}

export function mountStory(root: HTMLElement, book: Book, kit: Kit): () => void {
  const { DEFAULT_VAULT, MAX_DROP, dollars, dollarsShort, escapeHtml, findVault, percent, quote } = kit;
  const $ = (id: string) => root.querySelector(`#${id}`) as HTMLElement;
  const hero = root.querySelector(".lhero") as HTMLElement;
  const stage = $("hero-stage");
  const scene = $("hero-scene");
  const canvas = $("ribbons") as HTMLCanvasElement;
  const story = $("story");
  const pw = $("pw");
  const marker = $("sec-how");
  const ctx = canvas.getContext("2d");

  const v = findVault(book, DEFAULT_VAULT);
  const t = v.tokens[0] as TokenCurve;
  const end = quote(book, v, t, DROP, DEPOSIT);
  $("pw-picked").innerHTML = `<span class="pv-name">${escapeHtml(v.name)}</span><span class="pv-sub">${v.curator ? escapeHtml(v.curator) : "Curator not listed"}</span><span class="pv-dep">${dollarsShort(v.depositsUsd)}<small>deposits</small></span>`;
  $("pw-token").textContent = t.symbol;
  $("pw-loss").textContent = dollars(end.yourLoss);
  $("pw-premium").textContent = `${dollars(end.premium ?? 0)}`;
  $("pw-stamp").textContent = `Paid ${dollars(end.payout)} automatically`;
  pw.setAttribute(
    "aria-label",
    `The checker on ${v.name}: if ${t.symbol} drops ${percent(DROP, 0)}, your ${dollars(DEPOSIT)} would lose ${dollars(end.yourLoss)}. Cover costs ${dollars(end.premium ?? 0)} a year and pays ${dollars(end.payout)} automatically.`,
  );

  const fill = $("pw-fill");
  const thumb = $("pw-thumb");
  const dropEl = $("pw-drop");
  const vaultEl = $("pw-vault");
  const shareEl = $("pw-share");
  const set = (el: HTMLElement, s: string) => el.textContent !== s && (el.textContent = s);
  const fade = (id: string) => $(id).style;
  const mine = [...$("pw-mine").children].map((el) => (el as HTMLElement).style);
  const cover = fade("pw-cover");
  const stamp = fade("pw-stamp");
  const picked = $("pw-picked");
  let trackW = 0;

  /** The check itself, from 0 (nothing picked) to 1 (paid). */
  function session(s: number): void {
    picked.classList.toggle("on", s > 0.02);
    const d = DROP * ease(seg(s, 0.12, 0.5));
    const q = quote(book, v, t, d, DEPOSIT);
    set(dropEl, percent(d, 0));
    set(vaultEl, dollarsShort(q.vaultLoss));
    set(shareEl, percent(q.share));
    fill.style.transform = `scaleX(${(d / MAX_DROP).toFixed(4)})`;
    thumb.style.transform = `translateX(${((d / MAX_DROP) * trackW).toFixed(1)}px)`;
    const m = seg(s, 0.52, 0.64);
    for (const st of mine) {
      st.opacity = String(m);
      st.transform = `translateY(${(1 - m) * 10}px)`;
    }
    const c = seg(s, 0.66, 0.78);
    cover.opacity = String(0.25 + 0.75 * c);
    const st = ease(seg(s, 0.82, 0.96));
    stamp.opacity = String(st);
    stamp.transform = `translate(-50%, -50%) rotate(-6deg) scale(${lerp(1.7, 1, st).toFixed(3)})`;
  }

  // Sizes, read on resize only.
  let pinned = false;
  let range = 1;
  let stick = 0;
  let W = 0;
  let H = 0;
  let natW = 1;
  let natH = 1;
  let mid = { s: 1, y: 0 };
  let fin = { s: 1, y: 0 };
  const wide = window.matchMedia("(min-width: 760px) and (prefers-reduced-motion: no-preference)");
  function measure(): void {
    pinned = wide.matches;
    hero.classList.toggle("pinned", pinned);
    const inner = $("pw-in");
    natW = inner.offsetWidth;
    natH = inner.offsetHeight;
    trackW = (root.querySelector(".pw-range") as HTMLElement).offsetWidth;
    W = stage.clientWidth;
    H = stage.clientHeight;
    range = Math.max(1, hero.offsetHeight - H);
    stick = parseFloat(getComputedStyle(stage).top) || 0;
    // In the middle of the story the window is big and centred; at the end it makes room for the head,
    // the steps either side and the button below.
    const s1 = Math.min(1, (H * 0.84) / natH, (W * 0.6) / natW);
    const headH = (root.querySelector(".story-head") as HTMLElement).offsetHeight + 40;
    const s2 = Math.min(s1, (H - headH - 96) / natH, (W * 0.42) / natW);
    mid = { s: s1, y: 0 };
    fin = { s: s2, y: headH + (natH * s2) / 2 - H / 2 + 8 };
    story.style.setProperty("--pw-w", `${Math.round(natW * s2)}px`);
    story.style.setProperty("--pw-h", `${Math.round(natH * s2)}px`);
    story.style.setProperty("--pw-y", `${Math.round(headH + 8)}px`);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The nav's "How it works" lands where the steps have settled.
    marker.style.top = pinned ? `${Math.round(range * 0.93)}px` : `${story.offsetTop}px`;
    last = -1;
  }

  let last = -1;
  function frame(): void {
    raf = 0;
    if (!pinned) return;
    const p = clamp((stick - hero.getBoundingClientRect().top) / range);
    if (p === last) return;
    last = p;
    const out = ease(seg(p, 0.03, 0.2));
    scene.style.opacity = String(1 - out);
    scene.style.transform = `translateY(${(out * 160).toFixed(1)}px) scale(${(1 - 0.05 * out).toFixed(4)})`;
    scene.style.visibility = out >= 1 ? "hidden" : "visible";
    const rise = seg(p, 0.1, 0.32);
    const settle = ease(seg(p, 0.76, 0.9));
    canvas.style.opacity = String(1 - 0.75 * settle);
    if (ctx) drawRibbons(ctx, W, H, rise, p * 4);
    const up = ease(seg(p, 0.12, 0.3));
    const s = lerp(mid.s, fin.s, settle);
    const y = lerp(mid.y, fin.y, settle) + (1 - up) * H * 0.7;
    pw.style.opacity = String(up);
    pw.style.transform = `translate(-50%, -50%) translateY(${y.toFixed(1)}px) scale(${s.toFixed(4)})`;
    story.style.setProperty("--settle", settle.toFixed(4));
    story.classList.toggle("done", settle > 0.98);
    session(seg(p, 0.3, 0.74));
  }
  let raf = 0;
  const onScroll = () => (raf ||= requestAnimationFrame(frame));

  // Unpinned: play the check once as the window comes into view, or show its end with reduced motion.
  let played = false;
  const seen = new IntersectionObserver(
    ([e]) => {
      if (pinned || played || !e?.isIntersecting) return;
      played = true;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return session(1);
      const t0 = performance.now();
      const tick = (now: number) => {
        const k = clamp((now - t0) / 5200);
        session(k);
        if (k < 1 && !pinned) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { threshold: 0.3 },
  );

  function reset(): void {
    measure();
    if (!pinned) {
      for (const el of [scene, pw, canvas]) el.removeAttribute("style");
      story.style.removeProperty("--settle");
      story.classList.add("done");
      session(played || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 0);
      seen.observe(pw);
    } else {
      seen.disconnect();
      frame();
    }
  }
  const resize = new ResizeObserver(() => requestAnimationFrame(reset));
  resize.observe(stage);
  wide.addEventListener("change", reset);
  window.addEventListener("scroll", onScroll, { passive: true });
  reset();
  return () => {
    cancelAnimationFrame(raf);
    resize.disconnect();
    seen.disconnect();
    wide.removeEventListener("change", reset);
    window.removeEventListener("scroll", onScroll);
  };
}
