import { existsSync, readFileSync } from "node:fs";
import { type AdaptersFile, type LendingBook, type RawSnapshot, loadBook } from "../src/snapshot.js";

export const FIXTURE = new URL("../../fixtures/morpho/monad-2026-10-06.json", import.meta.url);
export const ADAPTERS = new URL("../../fixtures/morpho/monad-2026-10-06.adapters.json", import.meta.url);

let cached: LendingBook | undefined;

/** The 6 October 2026 Monad book, loaded once per test file. */
export function monadBook(): LendingBook {
  if (!cached) {
    const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as RawSnapshot;
    const adapters = existsSync(ADAPTERS) ? (JSON.parse(readFileSync(ADAPTERS, "utf8")) as AdaptersFile) : undefined;
    cached = loadBook(raw, adapters);
  }
  return cached;
}
