// Text over the picture: level labels, and one counter per band beside it.

import type { Geometry } from "./layout.js";
import type { Scene } from "./picture.js";

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

export function renderOverlay(el: HTMLElement, geo: Geometry, scene: Scene, text: OverlayText): void {
  const parts: string[] = [];
  const label = (x: number, y: number, t: string, cls = "") => parts.push(`<div class="label ${cls}" style="left:${x}px;top:${y}px">${t}</div>`);

  label(geo.rightX - 2, geo.priceY(1) - 3, text.now, "ink right above");
  if (scene.ghostRatio !== null && text.ghost) label(geo.rightX - 2, geo.priceY(scene.ghostRatio) - 3, text.ghost(scene.ghostRatio), "right above halo");
  if (scene.realRatio !== null && scene.ghostRatio !== null && scene.realRatio < scene.ghostRatio - 1e-4 && text.real) {
    label(geo.rightX - 2, geo.priceY(scene.realRatio) + 4, text.real(scene.realRatio), "ink right halo");
  }
  const step = geo.maxMove > 0.5 ? 0.25 : 0.1;
  for (let m = step; m <= geo.maxMove + 1e-9; m += step) label(geo.wallX - 12, geo.priceY(1 - m) - 7, text.tick(m), "right");

  // Counters, each at the height of its band, nudged apart so they never overlap.
  const level = geo.waterY(scene.water);
  const GAP = 56;
  const ys = scene.bands.map((_, i) => {
    const b = geo.band(i);
    return (b.top + b.bottom) / 2;
  });
  if (ys.length) ys[0] = Math.min(ys[0] as number, geo.basinBottom - GAP / 2);
  for (let i = 1; i < ys.length; i++) ys[i] = Math.min(ys[i] as number, (ys[i - 1] as number) - GAP);
  scene.bands.forEach((b, i) => {
    const y = ys[i] as number;
    const wet = scene.water > 0 && level < y;
    parts.push(
      `<div class="counter${wet ? " wet" : ""}" style="left:${geo.wallX + 20}px;top:${y}px"><span class="what">${b.label}</span><span class="amount">${usd(b.paid)}</span></div>`,
    );
  });

  el.innerHTML = parts.join("");
}
