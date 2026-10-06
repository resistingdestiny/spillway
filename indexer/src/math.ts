// Morpho Blue's integer math, line for line: morpho-blue/src/libraries/MathLib.sol and
// SharesMathLib.sol. The replay takes amounts from the events, so it never needs these to move state.
// It uses them to recompute what each event says from the replayed totals, which proves the totals
// match the chain's at every step.

export const WAD = 10n ** 18n;
/** SharesMathLib: VIRTUAL_SHARES = 1e6, VIRTUAL_ASSETS = 1. */
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;

export const mulDivDown = (x: bigint, y: bigint, d: bigint) => (x * y) / d;
export const mulDivUp = (x: bigint, y: bigint, d: bigint) => (x * y + (d - 1n)) / d;
export const wMulDown = (x: bigint, y: bigint) => mulDivDown(x, y, WAD);

/** e^(x n) - 1 to three terms, as Morpho compounds a per-second rate x over n seconds. */
export function wTaylorCompounded(x: bigint, n: bigint): bigint {
  const first = x * n;
  const second = mulDivDown(first, first, 2n * WAD);
  const third = mulDivDown(second, first, 3n * WAD);
  return first + second + third;
}

export const toSharesDown = (assets: bigint, totalAssets: bigint, totalShares: bigint) =>
  mulDivDown(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
export const toSharesUp = (assets: bigint, totalAssets: bigint, totalShares: bigint) =>
  mulDivUp(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
export const toAssetsDown = (shares: bigint, totalAssets: bigint, totalShares: bigint) =>
  mulDivDown(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
export const toAssetsUp = (shares: bigint, totalAssets: bigint, totalShares: bigint) =>
  mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);

/** UtilsLib.zeroFloorSub. */
export const zeroFloorSub = (x: bigint, y: bigint) => (x > y ? x - y : 0n);
export const min = (x: bigint, y: bigint) => (x < y ? x : y);
