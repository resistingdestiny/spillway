// The inputs, hashes and commands behind every number, shown in the app's Verify drawer.

import type { Bundle } from "@spillway/engine";
import { load } from "../load.js";
import { SNAPSHOT } from "../market.js";

export const REPO = "https://github.com/resistingdestiny/spillway";
export const RERUN = "pnpm --filter @spillway/lending run report fixtures/morpho/monad-2026-10-06.json --out bundle.json";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const copyable = (c: string): string => `<div class="cmd"><code>${c}</code><button type="button" class="copy" data-copy="${c}">Copy</button></div>`;

/** Copy buttons anywhere under `root`. Returns the remover. */
export function onCopy(root: HTMLElement): () => void {
  const handler = (e: Event) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.copy");
    if (!b) return;
    void navigator.clipboard?.writeText(b.dataset.copy ?? "").then(() => {
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = "Copy"), 1500);
    });
  };
  root.addEventListener("click", handler);
  return () => root.removeEventListener("click", handler);
}

/** Every published number names its inputs, so anyone can rerun it. */
export async function verifyFacts(): Promise<string> {
  const [bundle, lendingText] = await Promise.all([load<Bundle>("data/bundle.json"), fetch(SNAPSHOT).then((r) => r.text())]);
  const lending = JSON.parse(lendingText) as { takenAt: string; blockBefore: { number: number }; blockAfter: { number: number }; counts: { markets: number; positions: number } };
  const hash = await sha256(lendingText);
  const s = bundle.snapshot;
  const row = (k: string, v: string) => `<div class="row"><dt>${k}</dt><dd>${v}</dd></div>`;
  const stack = (k: string, v: string) => `<div class="row stack"><dt>${k}</dt><dd>${v}</dd></div>`;
  return `
    <section class="card" aria-labelledby="ver-lending">
      <h3 class="section" id="ver-lending">Monad lending</h3>
      <p class="explain">The app runs the stress test in your browser on this snapshot.</p>
      <dl class="rows">
        ${row("Source", "Morpho's public API and Monad mainnet, chain 143")}
        ${row("Blocks", `${lending.blockBefore.number.toLocaleString("en-US")} to ${lending.blockAfter.number.toLocaleString("en-US")}`)}
        ${row("Taken", lending.takenAt)}
        ${row("Contents", `${lending.counts.markets} markets, ${lending.counts.positions.toLocaleString("en-US")} positions`)}
        ${stack("SHA-256", `${copyable(hash)}<span class="muted">computed in your browser from the file this page uses</span>`)}
        ${stack("Rerun", copyable(RERUN))}
      </dl>
    </section>
    <section class="card" aria-labelledby="ver-perpl">
      <h3 class="section" id="ver-perpl">Perpl</h3>
      <p class="explain">The Perpl module replays this snapshot of the BTC perpetual.</p>
      <dl class="rows">
        ${row("Snapshot", `${s.network}, chain ${s.chainId}, block ${s.block.toLocaleString("en-US")}`)}
        ${row("Taken", s.takenAt)}
        ${stack("Rerun", copyable("pnpm --filter @spillway/web data"))}
      </dl>
    </section>
    <section class="card" aria-labelledby="ver-site">
      <h3 class="section" id="ver-site">This site</h3>
      <p class="explain">Built from this commit of the public repository.</p>
      <dl class="rows">
        ${stack("Code", copyable(__COMMIT__))}
        ${row("Repository", `<a href="${REPO}" target="_blank" rel="noopener">github.com/resistingdestiny/spillway</a>`)}
      </dl>
    </section>`;
}
