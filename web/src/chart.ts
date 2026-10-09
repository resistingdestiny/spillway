// The checker's loss curve: a sudden price drop along the bottom, the vault's loss as a share of its
// deposits up the side, and the current drop marked. Plain SVG, drawn at the element's own width.

const NS = "http://www.w3.org/2000/svg";

export interface Curve {
  /** Drops, 0 to `maxDrop`, and the loss share at each. */
  xs: number[];
  ys: number[];
  maxDrop: number;
  /** The drop to mark, and its loss share. */
  at: number;
  atY: number;
}

const pctLabel = (x: number) => `${Math.round(x * 100)}%`;

/** A round top for the y axis that fits the largest loss. */
function yTop(max: number): number {
  for (const t of [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.4, 0.5, 0.6, 0.8, 1]) if (max <= t + 1e-9) return t;
  return 1;
}

export function drawCurve(el: HTMLElement, c: Curve): void {
  const W = Math.max(280, el.clientWidth);
  const H = W < 480 ? 220 : 260;
  const m = { l: 44, r: 14, t: 14, b: 34 };
  const top = yTop(Math.max(...c.ys, 0));
  const x = (d: number) => m.l + (d / c.maxDrop) * (W - m.l - m.r);
  const y = (s: number) => H - m.b - (s / top) * (H - m.t - m.b);

  const parts: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const v = (top * i) / 4;
    parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`);
    parts.push(`<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${top < 0.05 ? `${(v * 100).toFixed(1)}%` : pctLabel(v)}</text>`);
  }
  for (let d = 0; d <= c.maxDrop + 1e-9; d += 0.1) parts.push(`<text x="${x(d)}" y="${H - m.b + 20}" text-anchor="middle">${pctLabel(d)}</text>`);
  const pts = c.xs.map((d, i) => `${x(d).toFixed(1)},${y(c.ys[i] ?? 0).toFixed(1)}`);
  parts.push(`<path class="area" d="M${x(0)},${y(0)} L${pts.join(" L")} L${x(c.xs[c.xs.length - 1] ?? c.maxDrop)},${y(0)} Z"/>`);
  parts.push(`<polyline class="line" points="${pts.join(" ")}"/>`);
  const px = x(c.at);
  const py = y(c.atY);
  parts.push(`<line class="mark" x1="${px}" x2="${px}" y1="${m.t}" y2="${H - m.b}"/>`);
  parts.push(`<circle class="dot" cx="${px}" cy="${py}" r="6"/>`);

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Loss as a share of deposits for price drops from 0 to ${pctLabel(c.maxDrop)}. At a ${pctLabel(c.at)} drop the vault loses ${(c.atY * 100).toFixed(1)}%.`);
  svg.innerHTML = parts.join("");
  el.replaceChildren(svg);
}
