// Geometry of the picture. Pure numbers, no drawing, so every renderer and the text overlay agree.
//
// Top: a cliff. The shock runs down the cliff face, from none to MAX_MOVE.
// Ledges stick out from the face at the shock that breaks them.
// Bottom: a basin with bands on its wall, drawn at a fixed dollars-per-pixel scale, lowest band first.

export const MAX_MOVE = 0.4;

export interface Geometry {
  W: number;
  H: number;
  /** The cliff face and the basin's left wall. */
  wallX: number;
  /** The basin's right wall. */
  rightX: number;
  cliffTop: number;
  cliffBottom: number;
  basinTop: number;
  basinBottom: number;
  /** Pixels per dollar in the basin. */
  basinScale: number;
  /** Pixels per dollar on a ledge. */
  ledgeScale: number;
  /** Size of each band in dollars, lowest first. */
  bands: number[];
  /** Largest move shown on the cliff. */
  maxMove: number;
  /** y of a level given as a ratio to today's (1 is today, 1 - maxMove is the bottom of the cliff). */
  priceY(ratio: number): number;
  /** y of the water surface for a given amount of loss. */
  waterY(dollars: number): number;
  /** y range of band i, top and bottom. */
  band(i: number): { top: number; bottom: number };
}

export function layout(W: number, H: number, bands: number[], biggestLedge: number, maxMove = MAX_MOVE): Geometry {
  // Margins leave room for the tick labels on the left and the marker pills above each line.
  const wallX = Math.round(Math.min(60, Math.max(48, W * 0.13)));
  const rightX = W - 14;
  const cliffTop = 44;
  const cliffBottom = Math.round(H * 0.5);
  const basinTop = Math.round(H * 0.57);
  const basinBottom = H - 14;

  const capacity = Math.max(1, bands.reduce((a, b) => a + b, 0));
  const basinScale = (basinBottom - basinTop) / capacity;
  const ledgeScale = biggestLedge > 0 ? ((rightX - wallX) * 0.86) / biggestLedge : 0;

  const priceY = (ratio: number) => cliffTop + ((1 - ratio) / maxMove) * (cliffBottom - cliffTop);
  const waterY = (dollars: number) => basinBottom - Math.max(0, dollars) * basinScale;
  const band = (i: number) => {
    const below = bands.slice(0, i).reduce((a, b) => a + b, 0);
    return { bottom: waterY(below), top: waterY(below + (bands[i] ?? 0)) };
  };

  return { W, H, wallX, rightX, cliffTop, cliffBottom, basinTop, basinBottom, basinScale, ledgeScale, bands, maxMove, priceY, waterY, band };
}
