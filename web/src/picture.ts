// Draws one moment of the picture on a WebGL canvas. Text lives in the DOM overlay (overlay.ts).

import { Application, Graphics } from "pixi.js";
import type { Ledge } from "@spillway/engine";
import type { Geometry } from "./layout.js";

export const COLORS = {
  bg: 0xffffff,
  ink: 0x0b0d10,
  muted: 0x9aa0a8,
  hair: 0xe7e9ed,
  guide: 0xeef0f3,
  ghost: 0xdfe2e7,
  water: 0x0a5cff,
  accent: 0xc6f432,
  danger: 0xe5322d,
  fundBand: 0xb9bec6,
};

/** One band on the basin wall, lowest first. */
export interface BandSpec {
  /** Counter text, e.g. "Insurance fund ($178k) pays". */
  label: string;
  /** Short tag on the band itself, e.g. "Insurance fund $178k". */
  tag: string;
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
    this.guides(geo);
    this.basin(geo, scene);
    this.falls(geo, scene);
    this.ledges(geo, scene);
    this.markers(geo, scene);
    this.face(geo);
  }

  /** Faint guide lines across the cliff every 10%, and small ticks every 5% on the face. */
  private guides(geo: Geometry): void {
    const g = this.g;
    for (let i = 1; i * 0.1 <= geo.maxMove + 1e-9; i++) {
      const y = Math.round(geo.priceY(1 - i * 0.1)) + 0.5;
      g.moveTo(geo.wallX, y).lineTo(geo.rightX, y);
    }
    g.stroke({ width: 1, color: COLORS.guide });
    for (let i = 1; i * 0.05 <= geo.maxMove + 1e-9; i++) {
      const y = Math.round(geo.priceY(1 - i * 0.05)) + 0.5;
      g.moveTo(geo.wallX - (i % 2 ? 3 : 6), y).lineTo(geo.wallX, y);
    }
    g.stroke({ width: 1, color: COLORS.ink });
  }

  /** The cliff face, running down into the basin's left wall. */
  private face(geo: Geometry): void {
    this.g.moveTo(geo.wallX, geo.cliffTop - 16).lineTo(geo.wallX, geo.basinBottom - RADIUS).stroke({ width: 1.5, color: COLORS.ink });
  }

  private basin(geo: Geometry, scene: Scene): void {
    const g = this.g;
    const { wallX, rightX, basinTop, basinBottom } = geo;
    const rim = basinTop - 6;
    const level = geo.waterY(scene.water);

    // Water, following the rounded floor.
    if (scene.water > 0) {
      const top = Math.max(rim, level);
      vessel(g, wallX, top, rightX, basinBottom);
      g.closePath().fill({ color: COLORS.water });
    }

    // Gauge strip inside the left wall: one colour per band.
    const strip = 5;
    let below = 0;
    scene.bands.forEach((b, i) => {
      const { top, bottom } = geo.band(i);
      const wet = scene.water > below + 1e-6;
      const t = Math.max(rim, top);
      const bt = Math.min(bottom, basinBottom - RADIUS);
      if ((!b.wetOnly || wet) && bt > t) g.rect(wallX + 3, t + 1, strip, bt - t - 2).fill({ color: b.color });
      below += b.dollars;
    });

    // Band edges across the basin.
    for (let i = 0; i < scene.bands.length - 1; i++) {
      const y = Math.round(geo.band(i).top) + 0.5;
      const wet = scene.water > 0 && level < y;
      g.moveTo(wallX + 12, y).lineTo(rightX - 1, y).stroke({ width: 1, color: wet ? 0xffffff : COLORS.muted, alpha: wet ? 0.45 : 0.6 });
    }

    // The vessel.
    vessel(g, wallX, rim, rightX, basinBottom);
    g.stroke({ width: 1.5, color: COLORS.ink });
  }

  private falls(geo: Geometry, scene: Scene): void {
    const g = this.g;
    const surface = scene.water > 0 ? Math.max(geo.basinTop - 6, geo.waterY(scene.water)) : geo.basinBottom - 1;
    for (const f of fallsOf(geo, scene)) {
      g.roundRect(f.x, f.y, f.w, surface - f.y, f.w / 2).fill({ color: COLORS.water, alpha: 0.55 });
    }
  }

  private ledges(geo: Geometry, scene: Scene): void {
    const g = this.g;
    const h = 6;
    // Broken ledges first, so a whole ledge at the same height draws over its ghost.
    for (const broken of [true, false]) {
      scene.ledges.forEach((l) => {
        if (l.broken !== broken || l.ratio < 1 - geo.maxMove) return;
        const y = geo.priceY(l.ratio) - h / 2;
        const w = ledgeWidth(geo, l);
        g.roundRect(geo.wallX - 1, y, w + 1, h, h / 2).fill({ color: broken ? COLORS.ghost : COLORS.ink });
      });
    }
  }

  private markers(geo: Geometry, scene: Scene): void {
    const g = this.g;
    const now = Math.round(geo.priceY(1)) + 0.5;
    g.moveTo(geo.wallX, now).lineTo(geo.rightX, now).stroke({ width: 1.5, color: COLORS.ink });
    if (scene.ghostRatio !== null) {
      const y = Math.round(geo.priceY(scene.ghostRatio)) + 0.5;
      dashed(g, geo.wallX, y, geo.rightX, y, 5, 4);
      g.stroke({ width: 1, color: COLORS.ink });
      g.circle(geo.wallX, y, 3.5).fill({ color: COLORS.ink });
    }
    if (scene.realRatio !== null && scene.ghostRatio !== null && scene.realRatio < scene.ghostRatio - 1e-4) {
      const y = Math.round(geo.priceY(scene.realRatio)) + 0.5;
      g.moveTo(geo.wallX, y).lineTo(geo.rightX, y).stroke({ width: 1.5, color: COLORS.ink });
      g.poly([geo.wallX, y, geo.wallX - 7, y - 4, geo.wallX - 7, y + 4]).fill({ color: COLORS.ink });
    }
  }
}

/** Corner radius of the basin's floor. */
const RADIUS = 12;

export const ledgeWidth = (geo: Geometry, l: PictureLedge): number => Math.max(12, l.dollars * geo.ledgeScale);

/** Where each stream of water leaves its broken ledge: x, top and width, in CSS pixels. */
export function fallsOf(geo: Geometry, scene: Scene): { x: number; y: number; w: number }[] {
  return scene.ledges
    .filter((l) => l.broken && l.water > 0 && l.ratio >= 1 - geo.maxMove)
    .map((l) => {
      const w = Math.min(5, Math.max(1.5, Math.sqrt(l.water) / 30));
      const tip = geo.wallX + ledgeWidth(geo, l);
      return { x: tip - w - 2, y: geo.priceY(l.ratio) + 2, w };
    });
}

/** The basin's outline from the left rim, round the floor, up to the right rim. */
function vessel(g: Graphics, x0: number, top: number, x1: number, bottom: number): Graphics {
  const r = Math.min(RADIUS, Math.max(0, bottom - top));
  g.moveTo(x0, top).lineTo(x0, bottom - r);
  g.arcTo(x0, bottom, x0 + r, bottom, r).lineTo(x1 - r, bottom);
  g.arcTo(x1, bottom, x1, bottom - r, r).lineTo(x1, top);
  return g;
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
