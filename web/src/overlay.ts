// Text over the picture: price labels, band names and the three counters.

import type { Geometry } from "./layout.js";
import type { Scene } from "./picture.js";

export const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
export const usdShort = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
};

export interface Paid {
  fundPaid: number;
  layerPaid: number;
  tradersLose: number;
}

export function renderOverlay(el: HTMLElement, geo: Geometry, scene: Scene, paid: Paid, symbol: string): void {
  const parts: string[] = [];
  const label = (x: number, y: number, text: string, cls = "") =>
    parts.push(`<div class="label ${cls}" style="left:${x}px;top:${y}px">${text}</div>`);

  // Price markers.
  label(geo.rightX - 2, geo.priceY(1) - 3, `${symbol} now ${usd(scene.mark)}`, "ink right above");
  if (scene.ghostRatio !== null) {
    const drop = (1 - scene.ghostRatio) * 100;
    label(geo.rightX - 2, geo.priceY(scene.ghostRatio) - 3, `Outside price −${drop.toFixed(1)}%  ${usd(scene.mark * scene.ghostRatio)}`, "right above halo");
  }
  if (scene.realRatio !== null && scene.ghostRatio !== null && scene.realRatio < scene.ghostRatio - 1e-4) {
    label(geo.rightX - 2, geo.priceY(scene.realRatio) + 4, `Perpl's book went to ${usd(scene.mark * scene.realRatio)}`, "ink right halo");
  }
  for (let m = 0.1; m <= 0.4 + 1e-9; m += 0.1) {
    label(geo.wallX - 12, geo.priceY(1 - m) - 7, `−${Math.round(m * 100)}%`, "right");
  }

  // Counters, each at the height of its band, nudged apart so they never overlap.
  const level = geo.waterY(scene.water);
  const rows: { band: "fund" | "layer" | "traders"; what: string; amount: number }[] = [
    { band: "fund", what: `Insurance fund (${usdShort(geo.bands.fund)}) pays`, amount: paid.fundPaid },
  ];
  if (scene.layerOn) rows.push({ band: "layer", what: `Spillway (${usdShort(geo.bands.layer)}) pays`, amount: paid.layerPaid });
  rows.push({ band: "traders", what: "Winning traders lose", amount: paid.tradersLose });
  const GAP = 56;
  const ys = rows.map((r) => {
    const b = geo.band(r.band);
    return (b.top + b.bottom) / 2;
  });
  // Bottom up: keep each counter at least GAP above the one below, and inside the basin.
  ys[0] = Math.min(ys[0] as number, geo.basinBottom - GAP / 2);
  for (let i = 1; i < ys.length; i++) ys[i] = Math.min(ys[i] as number, (ys[i - 1] as number) - GAP);
  rows.forEach((r, i) => {
    const y = ys[i] as number;
    const wet = scene.water > 0 && level < y;
    parts.push(
      `<div class="counter${wet ? " wet" : ""}" style="left:${geo.wallX + 20}px;top:${y}px"><span class="what">${r.what}</span><span class="amount">${usd(r.amount)}</span></div>`,
    );
  });

  el.innerHTML = parts.join("");
}
