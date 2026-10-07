import type { Bundle } from "@spillway/engine";
import { load } from "../load.js";

const LENDING = "data/lending/monad-2026-10-06.json";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every published number names its inputs, so anyone can rerun it. */
export async function mountVerify(root: HTMLElement): Promise<() => void> {
  root.innerHTML = `<div class="page"><div class="overline">Inputs, hashes and commands</div><h1 class="headline">Every number here can be rerun from public data</h1><section class="card"><p class="explain"><span class="skeleton" style="width:70%"></span></p><p class="explain"><span class="skeleton" style="width:50%"></span></p></section></div>`;
  const [bundle, lendingText] = await Promise.all([load<Bundle>("data/bundle.json"), fetch(LENDING).then((r) => r.text())]);
  const lending = JSON.parse(lendingText) as { takenAt: string; blockBefore: { number: number }; blockAfter: { number: number }; counts: { markets: number; positions: number } };
  const hash = await sha256(lendingText);
  const s = bundle.snapshot;
  const row = (k: string, v: string) => `<div class="row"><dt>${k}</dt><dd>${v}</dd></div>`;
  const cmd = (k: string, c: string) =>
    `<div class="row stack"><dt>${k}</dt><dd><div class="cmd"><code>${c}</code><button type="button" class="copy" data-copy="${c}">Copy</button></div></dd></div>`;
  root.innerHTML = `
    <div class="page">
      <div class="overline">Inputs, hashes and commands</div>
      <h1 class="headline">Every number here can be rerun from public data</h1>
      <section class="card" aria-labelledby="ver-lending">
        <h2 class="section" id="ver-lending">Monad lending</h2>
        <p class="explain">The Lending tab runs the stress test in your browser on this snapshot.</p>
        <dl class="rows">
          ${row("Source", "Morpho's public API and Monad mainnet, chain 143")}
          ${row("Blocks", `${lending.blockBefore.number.toLocaleString("en-US")} to ${lending.blockAfter.number.toLocaleString("en-US")}`)}
          ${row("Taken", lending.takenAt)}
          ${row("Contents", `${lending.counts.markets} markets, ${lending.counts.positions.toLocaleString("en-US")} positions`)}
          <div class="row stack"><dt>SHA-256</dt><dd><div class="cmd"><code>${hash}</code><button type="button" class="copy" data-copy="${hash}">Copy</button></div><span class="muted">computed in your browser from the file this page uses</span></dd></div>
          ${cmd("Rerun", "pnpm --filter @spillway/lending run report fixtures/morpho/monad-2026-10-06.json --out bundle.json")}
        </dl>
      </section>
      <section class="card" aria-labelledby="ver-perpl">
        <h2 class="section" id="ver-perpl">Perpl</h2>
        <p class="explain">The Perpl tab replays this snapshot of the BTC perpetual.</p>
        <dl class="rows">
          ${row("Snapshot", `${s.network}, chain ${s.chainId}, block ${s.block.toLocaleString("en-US")}`)}
          ${row("Taken", s.takenAt)}
          ${cmd("Rerun", "pnpm --filter @spillway/web data")}
        </dl>
      </section>
      <section class="card" aria-labelledby="ver-site">
        <h2 class="section" id="ver-site">This site</h2>
        <p class="explain">Built from this commit of the public repository.</p>
        <dl class="rows">
          <div class="row stack"><dt>Code</dt><dd><div class="cmd"><code>${__COMMIT__}</code><button type="button" class="copy" data-copy="${__COMMIT__}">Copy</button></div></dd></div>
          ${row("Repository", `<a href="https://github.com/resistingdestiny/spillway">github.com/resistingdestiny/spillway</a>`)}
        </dl>
      </section>
    </div>`;
  const onCopy = (e: Event) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.copy");
    if (!b) return;
    void navigator.clipboard?.writeText(b.dataset.copy ?? "").then(() => {
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = "Copy"), 1500);
    });
  };
  root.addEventListener("click", onCopy);
  return () => root.removeEventListener("click", onCopy);
}
