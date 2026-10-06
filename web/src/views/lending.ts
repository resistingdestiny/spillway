/** Monad lending: the risk map and cover. Filled in as the lending engine lands. */
export async function mountLending(root: HTMLElement): Promise<() => void> {
  root.innerHTML = `<p class="headline">Monad lending stress tests and cover are being built. The Perpl tab shows the first market.</p>`;
  return () => {};
}
