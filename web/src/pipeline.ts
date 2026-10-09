// The landing page's dark band: one faint line per open position on Monad's Morpho markets,
// converging on one point and running on into the timeline. A 2D canvas, drawn only while on screen.

const STAGES = ["Read the chain", "Stress test", "Price", "Underwrite", "Watch", "Prove", "Pay"];

interface Line {
  x0: number;
  y0: number;
  speed: number;
  phase: number;
  bright: boolean;
}

/** A small deterministic generator, so the picture is the same on every visit. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export const pipelineHtml = (): string => `
  <div class="pipe" id="pipe">
    <canvas class="pipe-canvas" id="pipe-canvas" aria-hidden="true"></canvas>
    <ol class="pipe-track">
      ${STAGES.map((s, i) => `<li style="--i:${i}"><span class="pipe-n">0${i + 1}</span><span class="pipe-label">${s}</span></li>`).join("")}
    </ol>
  </div>`;

/** Start the canvas for `count` lines. Returns the remover. */
export function mountPipeline(root: HTMLElement, count: number): () => void {
  const pipe = root.querySelector("#pipe") as HTMLElement;
  const canvas = root.querySelector("#pipe-canvas") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const rnd = random(1109);
  const lines: Line[] = Array.from({ length: count }, () => {
    // More lines near the middle, as in a bundle of fibres.
    const u = (rnd() + rnd() + rnd()) / 3;
    return { x0: rnd() * 0.5, y0: u, speed: 0.05 + rnd() * 0.07, phase: rnd(), bright: rnd() < 0.08 };
  });

  let W = 0;
  let H = 0;
  let wide = true;
  let cx = 0;
  let cy = 0;
  let base: HTMLCanvasElement | null = null;

  /** The point at t along line l: a cubic from its start to the convergence point. */
  const at = (l: Line, t: number): [number, number] => {
    const x0 = l.x0 * cx * 0.45;
    const y0 = (l.y0 - 0.5) * H * 1.15 + cy;
    const x1 = cx * 0.55;
    const x2 = cx * 0.8;
    const y2 = cy + (y0 - cy) * 0.12;
    const m = 1 - t;
    const x = m * m * m * x0 + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t * t * t * cx;
    const y = m * m * m * y0 + 3 * m * m * t * y0 + 3 * m * t * t * y2 + t * t * t * cy;
    return [x, y];
  };

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = pipe.clientWidth;
    H = canvas.clientHeight;
    if (W === 0 || H === 0) {
      base = null;
      return;
    }
    // The same breakpoint as the timeline in the stylesheet.
    wide = window.matchMedia("(min-width: 760px)").matches;
    cx = wide ? W * 0.22 : W * 0.86;
    cy = H * 0.5;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The faint lines never move, so draw them once.
    base = document.createElement("canvas");
    base.width = canvas.width;
    base.height = canvas.height;
    const b = base.getContext("2d")!;
    b.setTransform(dpr, 0, 0, dpr, 0, 0);
    b.lineWidth = 0.6;
    b.strokeStyle = "rgba(170, 196, 230, 0.07)";
    b.beginPath();
    for (const l of lines) {
      const [x, y] = at(l, 0);
      b.moveTo(x, y);
      for (let k = 1; k <= 24; k++) {
        const [px, py] = at(l, k / 24);
        b.lineTo(px, py);
      }
    }
    b.stroke();
    // The timeline from the convergence point to the edge.
    b.strokeStyle = "rgba(255, 255, 255, 0.22)";
    b.setLineDash([3, 4]);
    b.beginPath();
    b.moveTo(cx, cy);
    b.lineTo(wide ? W : W, cy);
    b.stroke();
  }

  function frame(time: number): void {
    if (!base) return;
    const c = ctx!;
    c.clearRect(0, 0, W, H);
    c.drawImage(base, 0, 0, W, H);
    const s = time / 1000;
    for (const bright of [false, true]) {
      c.beginPath();
      for (const l of lines) {
        if (l.bright !== bright) continue;
        const t = (s * l.speed + l.phase) % 1;
        const t0 = Math.max(0, t - 0.09);
        const [x0, y0] = at(l, t0);
        const [xm, ym] = at(l, (t0 + t) / 2);
        const [x1, y1] = at(l, t);
        c.moveTo(x0, y0);
        c.lineTo(xm, ym);
        c.lineTo(x1, y1);
      }
      c.lineWidth = bright ? 1.1 : 0.8;
      c.strokeStyle = bright ? "rgba(198, 244, 50, 0.75)" : "rgba(120, 166, 255, 0.5)";
      c.stroke();
    }
    // A pulse running down the timeline.
    if (wide) {
      const k = (s * 0.12) % 1;
      const x = cx + (W - cx) * k;
      c.fillStyle = "rgba(255, 255, 255, 0.9)";
      c.beginPath();
      c.arc(x, cy, 2.2, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = "#ffffff";
    c.beginPath();
    c.arc(cx, cy, 3, 0, Math.PI * 2);
    c.fill();
  }

  let raf = 0;
  let visible = false;
  const loop = (t: number) => {
    frame(t);
    if (visible) raf = requestAnimationFrame(loop);
  };
  resize();
  frame(reduced ? 4200 : performance.now());

  const seen = new IntersectionObserver(([e]) => {
    visible = Boolean(e?.isIntersecting) && !reduced;
    cancelAnimationFrame(raf);
    if (visible) raf = requestAnimationFrame(loop);
  });
  seen.observe(pipe);
  const ro = new ResizeObserver(() => {
    resize();
    frame(reduced ? 4200 : performance.now());
  });
  ro.observe(pipe);
  return () => {
    visible = false;
    cancelAnimationFrame(raf);
    seen.disconnect();
    ro.disconnect();
  };
}
