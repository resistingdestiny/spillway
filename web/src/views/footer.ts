// The footer every page ends on: what Spillway is, and links into the product, the proof and the code.

import { REPO } from "./verify.js";

export const FOOTER = `
    <footer class="foot">
      <div class="wrap foot-grid">
        <div class="foot-brand">
          <span class="brand-name">Spillway</span>
          <p>Insurance for Morpho vaults on Monad. Built for Monad Metropolis, October 2026.</p>
        </div>
        <nav aria-label="Product"><h3>Product</h3><a href="#/check">Check a vault</a><button type="button" class="foot-ask" data-ask>Ask Spillway</button><a href="#/perpl">Perpl</a></nav>
        <nav aria-label="Proof"><h3>Proof</h3><a href="#/check/proof">Testnet payout</a><a href="#/check/verify">Rerun the numbers</a></nav>
        <nav aria-label="Code"><h3>Code</h3><a href="${REPO}" target="_blank" rel="noopener">GitHub</a></nav>
      </div>
    </footer>`;

/** Makes the footer's Ask link open the Ask panel. Returns the remover. */
export function onFooterAsk(root: HTMLElement): () => void {
  const onAsk = (e: Event) => (e.target as HTMLElement).closest("[data-ask]") && document.querySelector<HTMLButtonElement>(".ask-fab")?.click();
  root.addEventListener("click", onAsk);
  return () => root.removeEventListener("click", onAsk);
}
