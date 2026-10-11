// Which clay object stands for which vault. The default vault is the dam; the next six by deposits
// take the other objects in turn. Every other vault is the small cistern. Shared by the landing
// page's landscape and the checker's stage.

import { type Book, DEFAULT_VAULT, type Vault, findVault } from "./vaults.js";

export interface Sprite {
  file: string;
  /** Left, top and width in landscape units (the landscape is 1200 by 500), and the image's own aspect. */
  x: number;
  y: number;
  w: number;
  aspect: number;
  /** Where the landscape's card points, in landscape units. */
  ax: number;
  ay: number;
}

const DAM: Sprite = { file: "dam", x: 372, y: 168, w: 456, aspect: 500 / 1200, ax: 720, ay: 214 };
/** The other vaults, biggest first, take these in turn. */
const OTHERS: Sprite[] = [
  { file: "tanks", x: 112, y: 214, w: 214, aspect: 557 / 640, ax: 248, ay: 250 },
  { file: "reservoir", x: 846, y: 150, w: 176, aspect: 529 / 640, ax: 880, ay: 190 },
  { file: "pump-house", x: 1010, y: 248, w: 156, aspect: 598 / 600, ax: 1060, ay: 290 },
  { file: "water-tower", x: 300, y: 62, w: 98, aspect: 1005 / 520, ax: 376, ay: 150 },
  { file: "lock", x: 24, y: 384, w: 236, aspect: 317 / 760, ax: 200, ay: 410 },
  { file: "sluice", x: 852, y: 330, w: 118, aspect: 596 / 560, ax: 880, ay: 370 },
];
/** The object for any vault outside the landscape. */
export const CISTERN = { file: "cistern", aspect: 560 / 550 };

/** Sprite and vault pairs: the default vault on the dam, the next six by deposits around it. */
export function cast(book: Book): [Sprite, Vault][] {
  const dam = findVault(book, DEFAULT_VAULT);
  const rest = book.vaults.filter((v) => v !== dam).slice(0, OTHERS.length);
  return [[DAM, dam] as [Sprite, Vault], ...rest.map((v, i) => [OTHERS[i] as Sprite, v] as [Sprite, Vault])];
}

/** The object a vault stands as: its landscape sprite, or the cistern. */
export const objectOf = (pairs: [Sprite, Vault][], v: Vault): { file: string; aspect: number } => pairs.find(([, x]) => x === v)?.[0] ?? CISTERN;
