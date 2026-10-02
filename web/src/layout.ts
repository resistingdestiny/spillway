// Geometry of the picture. Pure numbers, no drawing, so every renderer and the text overlay agree.
//
// Top: a cliff. Price runs down the cliff face, from today's price to MAX_MOVE below it.
// Ledges stick out from the face at the price where their positions liquidate.
// Bottom: a basin with three bands on its wall, drawn at a fixed dollars-per-pixel scale.

export const MAX_MOVE = 0.4;

export interface Bands {
  fund: number;
  layer: number;
  /** Height given to the winning traders band, in dollars. It has no natural size. */
  traders: number;
}

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
  /** Pixels per dollar of position on a ledge. */
  ledgeScale: number;
  bands: Bands;
  /** y of a price given as a ratio to today's price. */
  priceY(ratio: number): number;
  /** y of the water surface for a given amount of bad debt. */
  waterY(dollars: number): number;
  /** y range of each band, top and bottom. */
  band(name: keyof Bands): { top: number; bottom: number };
}

export function layout(W: number, H: number, fund: number, layerLimit: number, biggestLedge: number): Geometry {
  const wallX = Math.round(Math.min(64, W * 0.15));
  const rightX = W - 2;
  const cliffTop = 34;
  const cliffBottom = Math.round(H * 0.5);
  const basinTop = Math.round(H * 0.56);
  const basinBottom = H - 2;

  const traders = Math.max((fund + layerLimit) * 0.35, 1);
  const bands: Bands = { fund, layer: layerLimit, traders };
  const capacity = fund + layerLimit + traders;
  const basinScale = (basinBottom - basinTop) / capacity;
  const ledgeScale = biggestLedge > 0 ? ((rightX - wallX) * 0.86) / biggestLedge : 0;

  const priceY = (ratio: number) => cliffTop + ((1 - ratio) / MAX_MOVE) * (cliffBottom - cliffTop);
  const waterY = (dollars: number) => basinBottom - Math.max(0, dollars) * basinScale;
  const band = (name: keyof Bands) => {
    const below = name === "fund" ? 0 : name === "layer" ? fund : fund + layerLimit;
    return { bottom: waterY(below), top: waterY(below + bands[name]) };
  };

  return { W, H, wallX, rightX, cliffTop, cliffBottom, basinTop, basinBottom, basinScale, ledgeScale, bands, priceY, waterY, band };
}
