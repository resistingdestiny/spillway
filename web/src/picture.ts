// Draws one moment of the picture on a WebGL canvas. Text lives in the DOM overlay (overlay.ts).

import { Application, Graphics } from "pixi.js";
import type { Ledge } from "@spillway/engine";
import type { Geometry } from "./layout.js";

export const COLORS = {
  bg: 0xffffff,
  ink: 0x0e0f11,
  muted: 0x9aa0a8,
  hair: 0xd9dce1,
  rock: 0xf1f2f4,
  water: 0x0a5cff,
  accent: 0xc6f432,
  danger: 0xe5322d,
  fundBand: 0xb9bec6,
};

export interface Scene {
  mark: number;
  ledges: Ledge[];
  /** Per ledge: was it broken, and how much bad debt poured off it. */
  broken: boolean[];
  ledgeBadDebt: number[];
  /** Outside price after the move, as a ratio to today's price. Null when nothing has moved. */
  ghostRatio: number | null;
  /** Lowest price Perpl's book traded at, as a ratio. */
  realRatio: number | null;
  /** Total bad debt: the water in the basin. */
  water: number;
  /** Whether the Spillway band exists in this run. */
  layerOn: boolean;
}

export class Picture {
  readonly app = new Application();
  private g = new Graphics();
  private el!: HTMLElement;

  async mount(el: HTMLElement): Promise<void> {
    this.el = el;
    await this.app.init({
      background: COLORS.bg,
      width: el.clientWidth,
      height: el.clientHeight,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    el.appendChild(this.app.canvas);
    this.app.stage.addChild(this.g);
  }

  /** Match the canvas to its container and return the size in CSS pixels. */
  fit(): { W: number; H: number } {
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    if (this.app.renderer.screen.width !== W || this.app.renderer.screen.height !== H) this.app.renderer.resize(W, H);
    return { W, H };
  }

  draw(geo: Geometry, scene: Scene): void {
    const g = this.g;
    g.clear();
    this.rock(geo);
    this.ticks(geo);
    this.basin(geo, scene);
    this.falls(geo, scene);
    this.ledges(geo, scene);
    this.markers(geo, scene);
    g.zIndex = 0;
  }

  private rock(geo: Geometry): void {
    const g = this.g;
    const top = geo.cliffTop - 18;
    g.rect(0, top, geo.wallX, geo.basinBottom - top).fill({ color: COLORS.rock });
    // Hatching on the rock.
    for (let x = -geo.H; x < geo.wallX; x += 9) {
      g.moveTo(Math.max(0, x), top + Math.max(0, -x)).lineTo(Math.min(geo.wallX, x + (geo.basinBottom - top)), top + Math.min(geo.basinBottom - top, geo.wallX - x));
    }
    g.stroke({ width: 1, color: COLORS.hair });
    // The cliff face runs down into the basin's left wall.
    g.moveTo(geo.wallX, top).lineTo(geo.wallX, geo.basinBottom).stroke({ width: 2, color: COLORS.ink });
  }

  private ticks(geo: Geometry): void {
    const g = this.g;
    for (let m = 0.05; m <= 0.4 + 1e-9; m += 0.05) {
      const y = geo.priceY(1 - m);
      g.moveTo(geo.wallX - 8, y).lineTo(geo.wallX, y);
    }
    g.stroke({ width: 1, color: COLORS.ink });
  }

  private basin(geo: Geometry, scene: Scene): void {
    const g = this.g;
    const { wallX, rightX, basinTop, basinBottom } = geo;
    const level = geo.waterY(scene.water);
    const fund = geo.band("fund");
    const layer = geo.band("layer");
    const traders = geo.band("traders");

    // Water.
    if (scene.water > 0) {
      const top = Math.max(basinTop - 6, level);
      g.rect(wallX, top, rightX - wallX, basinBottom - top).fill({ color: COLORS.water });
    }

    // Gauge strip on the wall: one band each.
    const strip = 8;
    g.rect(wallX + 2, fund.top, strip, fund.bottom - fund.top).fill({ color: COLORS.fundBand });
    if (scene.layerOn) g.rect(wallX + 2, layer.top, strip, layer.bottom - layer.top).fill({ color: COLORS.accent });
    const tradersWet = scene.water > geo.bands.fund + (scene.layerOn ? geo.bands.layer : 0) + 1e-6;
    if (tradersWet) g.rect(wallX + 2, traders.top, strip, traders.bottom - traders.top).fill({ color: COLORS.danger });

    // Band edges across the basin, dashed.
    const edges = scene.layerOn ? [fund.top, layer.top] : [fund.top];
    for (const y of edges) dashed(g, wallX, y, rightX, y, 6, 5);
    g.stroke({ width: 1, color: scene.water > 0 ? 0xffffff : COLORS.muted, alpha: 0.9 });

    // The vessel.
    g.moveTo(wallX, basinTop - 6).lineTo(wallX, basinBottom).lineTo(rightX, basinBottom).lineTo(rightX, basinTop - 6);
    g.stroke({ width: 2, color: COLORS.ink });
  }

  private falls(geo: Geometry, scene: Scene): void {
    const g = this.g;
    const surface = scene.water > 0 ? Math.max(geo.basinTop - 6, geo.waterY(scene.water)) : geo.basinBottom;
    scene.ledges.forEach((l, i) => {
      const bd = scene.ledgeBadDebt[i] ?? 0;
      if (!scene.broken[i] || bd <= 0) return;
      const y = geo.priceY(l.price / scene.mark);
      const tip = geo.wallX + Math.max(14, l.notional * geo.ledgeScale);
      const w = Math.min(10, Math.max(1.5, Math.sqrt(bd) / 15));
      g.rect(tip - w, y + 3, w, surface - y - 3).fill({ color: COLORS.water, alpha: 0.45 });
    });
  }

  private ledges(geo: Geometry, scene: Scene): void {
    const g = this.g;
    const h = 5;
    scene.ledges.forEach((l, i) => {
      const ratio = l.price / scene.mark;
      if (ratio < 0.6) return;
      const y = geo.priceY(ratio) - h / 2;
      const w = Math.max(14, l.notional * geo.ledgeScale);
      if (!scene.broken[i]) {
        g.rect(geo.wallX, y, w, h).fill({ color: COLORS.ink });
        return;
      }
      // A broken ledge: a stub stays in the rock and a dashed outline marks where it was.
      const stub = 6;
      g.rect(geo.wallX, y, stub, h).fill({ color: COLORS.ink });
      dashed(g, geo.wallX + stub, y, geo.wallX + w, y, 3, 3);
      dashed(g, geo.wallX + stub, y + h, geo.wallX + w, y + h, 3, 3);
      g.moveTo(geo.wallX + w, y).lineTo(geo.wallX + w, y + h);
      g.stroke({ width: 1, color: COLORS.muted });
    });
  }

  private markers(geo: Geometry, scene: Scene): void {
    const g = this.g;
    const now = geo.priceY(1);
    g.moveTo(geo.wallX, now).lineTo(geo.rightX, now).stroke({ width: 2, color: COLORS.ink });
    if (scene.ghostRatio !== null) {
      const y = geo.priceY(scene.ghostRatio);
      dashed(g, geo.wallX, y, geo.rightX, y, 4, 4);
      g.stroke({ width: 1.5, color: COLORS.ink });
    }
    if (scene.realRatio !== null && scene.ghostRatio !== null && scene.realRatio < scene.ghostRatio - 1e-4) {
      const y = geo.priceY(scene.realRatio);
      g.moveTo(geo.wallX, y).lineTo(geo.rightX, y).stroke({ width: 2.5, color: COLORS.ink });
      // A small pointer on the cliff face.
      g.poly([geo.wallX, y, geo.wallX - 9, y - 5, geo.wallX - 9, y + 5]).fill({ color: COLORS.ink });
    }
  }
}

function dashed(g: Graphics, x0: number, y0: number, x1: number, y1: number, on: number, off: number): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const dx = (x1 - x0) / len;
  const dy = (y1 - y0) / len;
  for (let d = 0; d < len; d += on + off) {
    const e = Math.min(len, d + on);
    g.moveTo(x0 + dx * d, y0 + dy * d).lineTo(x0 + dx * e, y0 + dy * e);
  }
}
