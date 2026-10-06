import type { Bundle } from "@spillway/engine";
import { load } from "../load.js";

const LENDING = "data/lending/monad-2026-10-06.json";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every published number names its inputs, so anyone can rerun it. */
export async function mountVerify(root: HTMLElement): Promise<() => void> {
  const [bundle, lendingText] = await Promise.all([load<Bundle>("data/bundle.json"), fetch(LENDING).then((r) => r.text())]);
  const lending = JSON.parse(lendingText) as { takenAt: string; blockBefore: { number: number }; blockAfter: { number: number }; counts: { markets: number; positions: number } };
  const hash = await sha256(lendingText);
  const s = bundle.snapshot;
  root.innerHTML = `
    <p class="headline">Every number here can be rerun from public data.</p>
    <h2 class="section">Monad lending</h2>
    <dl class="manifest">
      <dt>Source</dt><dd>Morpho's public API and Monad mainnet, chain 143</dd>
      <dt>Blocks</dt><dd>${lending.blockBefore.number.toLocaleString("en-US")} to ${lending.blockAfter.number.toLocaleString("en-US")}</dd>
      <dt>Taken</dt><dd>${lending.takenAt}</dd>
      <dt>Contents</dt><dd>${lending.counts.markets} markets, ${lending.counts.positions.toLocaleString("en-US")} positions</dd>
      <dt>SHA-256</dt><dd><code>${hash}</code><br><span class="muted">computed in your browser from the file this page uses</span></dd>
      <dt>Rerun</dt><dd><code>pnpm --filter @spillway/lending run report fixtures/morpho/monad-2026-10-06.json --out bundle.json</code></dd>
    </dl>
    <h2 class="section">Perpl</h2>
    <dl class="manifest">
      <dt>Snapshot</dt><dd>${s.network}, chain ${s.chainId}, block ${s.block.toLocaleString("en-US")}</dd>
      <dt>Taken</dt><dd>${s.takenAt}</dd>
      <dt>Rerun</dt><dd><code>pnpm --filter @spillway/web data</code></dd>
    </dl>
    <h2 class="section">This site</h2>
    <dl class="manifest">
      <dt>Code</dt><dd><code>${__COMMIT__}</code></dd>
      <dt>Repository</dt><dd><a href="https://github.com/resistingdestiny/spillway">github.com/resistingdestiny/spillway</a></dd>
    </dl>`;
  return () => {};
}
