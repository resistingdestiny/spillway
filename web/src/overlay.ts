// Text over the picture: level labels and a tag on each band, placed clear of the falling water.
// The counters, one per band, sit in a legend under the picture.

import type { Geometry } from "./layout.js";
import { type Scene, fallsOf } from "./picture.js";

export const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
export const usdShort = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
};

export interface OverlayText {
  /** Label on the top line, e.g. "BTC now $84,263". */
  now: string;
  /** Label on the ghost marker for the current ratio. */
  ghost?: (ratio: number) => string;
  /** Label on the real marker for the current ratio. */
  real?: (ratio: number) => string;
  /** Tick label for a move, e.g. "-10%". */
  tick: (move: number) => string;
}

/** Rough width of a small label, in CSS pixels, for placing it clear of the falls. */
const textWidth = (t: string, px: number) => t.length * px * 0.56;

export function renderOverlay(el: HTMLElement, geo: Geometry, scene: Scene, text: OverlayText, legend?: HTMLElement): void {
  const parts: string[] = [];
  const label = (x: number, y: number, t: string, cls = "") => parts.push(`<div class="label ${cls}" style="left:${x}px;top:${y}px">${t}</div>`);

  label(geo.rightX, geo.priceY(1) - 6, text.now, "now right above");
  if (scene.ghostRatio !== null && text.ghost) label(geo.rightX, geo.priceY(scene.ghostRatio) - 6, text.ghost(scene.ghostRatio), "pill right above");
  if (scene.realRatio !== null && scene.ghostRatio !== null && scene.realRatio < scene.ghostRatio - 1e-4 && text.real) {
    label(geo.rightX, geo.priceY(scene.realRatio) + 6, text.real(scene.realRatio), "pill solid right");
  }
  const step = geo.maxMove > 0.5 ? 0.25 : 0.1;
  for (let m = step; m <= geo.maxMove + 1e-9; m += step) label(geo.wallX - 9, geo.priceY(1 - m), text.tick(m), "tick right");

  // A tag on each band, at its middle, in the first slot along the band that no stream crosses.
  const level = scene.water > 0 ? Math.max(geo.basinTop - 6, geo.waterY(scene.water)) : geo.basinBottom;
  const falls = fallsOf(geo, scene);
  const H = 22;
  scene.bands.forEach((b, i) => {
    const band = geo.band(i);
    const top = Math.max(band.top, geo.basinTop);
    const bottom = Math.min(band.bottom, geo.basinBottom - 4);
    if (bottom - top < H) return;
    let y = (top + bottom) / 2;
    // Keep the tag wholly above or below the water's surface.
    if (Math.abs(y - level) < H / 2 + 3) y = level + H / 2 + 4 <= bottom - H / 2 ? level + H / 2 + 4 : level - H / 2 - 4;
    if (y - H / 2 < top || y + H / 2 > bottom) return;
    const wet = level < y;
    const w = textWidth(b.tag, 12) + 20;
    // Falls only reach down to the surface, so under water every slot is free.
    const hits = (x0: number) => !wet && falls.some((f) => f.x + f.w + 4 > x0 && f.x - 4 < x0 + w && f.y < y + H / 2);
    const slots: number[] = [geo.wallX + 16];
    for (const f of [...falls].sort((p, q) => p.x - q.x)) slots.push(f.x + f.w + 6);
    const x = slots.find((x0) => x0 + w <= geo.rightX - 6 && !hits(x0));
    if (x === undefined) return;
    parts.push(`<div class="tag${wet ? " wet" : ""}" style="left:${x}px;top:${y}px">${b.tag}</div>`);
  });
  el.innerHTML = parts.join("");

  if (!legend) return;
  let below = 0;
  legend.innerHTML = scene.bands
    .map((b) => {
      const wet = scene.water > below + 1e-6;
      below += b.dollars;
      const swatch = `#${b.color.toString(16).padStart(6, "0")}`;
      const cls = ["counter", wet ? "wet" : "", b.wetOnly ? "loses" : ""].join(" ").trim();
      return `<div class="${cls}" style="--swatch:${swatch}"><span class="what">${b.label}</span><span class="amount">${usd(b.paid)}</span></div>`;
    })
    .join("");
}
