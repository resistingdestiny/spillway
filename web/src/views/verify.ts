import type { Bundle } from "@spillway/engine";
import { load } from "../load.js";

/** Every published number names its inputs, so anyone can rerun it. */
export async function mountVerify(root: HTMLElement): Promise<() => void> {
  const bundle = await load<Bundle>("data/bundle.json");
  const s = bundle.snapshot;
  root.innerHTML = `
    <p class="headline">Every number here can be rerun from public data.</p>
    <dl class="manifest">
      <dt>Perpl snapshot</dt><dd>${s.network}, chain ${s.chainId}, block ${s.block.toLocaleString("en-US")}</dd>
      <dt>Taken</dt><dd>${s.takenAt}</dd>
      <dt>Bundle generated</dt><dd>${bundle.generatedAt}</dd>
      <dt>Rerun</dt><dd><code>pnpm --filter @spillway/web data</code></dd>
    </dl>`;
  return () => {};
}
