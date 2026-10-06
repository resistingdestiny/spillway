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

/** One band on the basin wall, lowest first. */
export interface BandSpec {
  /** Counter text, e.g. "Insurance fund ($178k) pays". */
  label: string;
  /** Size of the band in dollars. */
  dollars: number;
  /** What this band has paid in the current run. */
  paid: number;
  /** Colour of its strip on the wall. */
  color: number;
  /** Only coloured once water reaches it (the people who lose when everything else is used up). */
  wetOnly?: boolean;
}

/** A ledge: positions that break at one level of the shock. */
export interface PictureLedge {
  /** Level as a ratio to today: 1 is today, 0.9 is a 10% move. */
  ratio: number;
  /** Width in dollars. */
  dollars: number;
  broken: boolean;
  /** Loss that poured off it. */
  water: number;
}

export interface Scene {
  ledges: PictureLedge[];
  /** Where the shock took the outside price, as a ratio. Null when nothing has moved. */
  ghostRatio: number | null;
  /** Where the market actually traded, as a ratio, if it went further. */
  realRatio: number | null;
  /** Total loss: the water in the basin. */
  water: number;
  bands: BandSpec[];
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

  destroy(): void {
    this.app.destroy(true, { children: true });
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

    // Water.
    if (scene.water > 0) {
      const top = Math.max(basinTop - 6, level);
      g.rect(wallX, top, rightX - wallX, basinBottom - top).fill({ color: COLORS.water });
    }

    // Gauge strip on the wall: one colour per band.
    const strip = 8;
    let below = 0;
    scene.bands.forEach((b, i) => {
      const { top, bottom } = geo.band(i);
      const wet = scene.water > below + 1e-6;
      if (!b.wetOnly || wet) g.rect(wallX + 2, top, strip, bottom - top).fill({ color: b.color });
      below += b.dollars;
    });

    // Band edges across the basin, dashed.
    for (let i = 0; i < scene.bands.length - 1; i++) {
      const y = geo.band(i).top;
      dashed(g, wallX, y, rightX, y, 6, 5);
    }
    g.stroke({ width: 1, color: scene.water > 0 ? 0xffffff : COLORS.muted, alpha: 0.9 });

    // The vessel.
    g.moveTo(wallX, basinTop - 6).lineTo(wallX, basinBottom).lineTo(rightX, basinBottom).lineTo(rightX, basinTop - 6);
    g.stroke({ width: 2, color: COLORS.ink });
  }

  private falls(geo: Geometry, scene: Scene): void {
    const g = this.g;
    const surface = scene.water > 0 ? Math.max(geo.basinTop - 6, geo.waterY(scene.water)) : geo.basinBottom;
    scene.ledges.forEach((l) => {
      const bd = l.water;
      if (!l.broken || bd <= 0) return;
      const y = geo.priceY(l.ratio);
      const tip = geo.wallX + Math.max(14, l.dollars * geo.ledgeScale);
      const w = Math.min(10, Math.max(1.5, Math.sqrt(bd) / 15));
      g.rect(tip - w, y + 3, w, surface - y - 3).fill({ color: COLORS.water, alpha: 0.45 });
    });
  }

  private ledges(geo: Geometry, scene: Scene): void {
    const g = this.g;
    const h = 5;
    scene.ledges.forEach((l) => {
      if (l.ratio < 1 - geo.maxMove) return;
      const y = geo.priceY(l.ratio) - h / 2;
      const w = Math.max(14, l.dollars * geo.ledgeScale);
      if (!l.broken) {
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
