import { mountLending } from "./views/lending.js";
import { mountPerpl } from "./views/perpl.js";
import { mountVerify } from "./views/verify.js";

type Mount = (root: HTMLElement) => Promise<() => void>;
// Cover loads on demand, so viem is only fetched by visitors who open it.
const mountCover: Mount = (root) => import("./views/cover.js").then((m) => m.mountCover(root));
const VIEWS: Record<string, Mount> = { lending: mountLending, cover: mountCover, perpl: mountPerpl, verify: mountVerify };

const root = document.getElementById("view") as HTMLElement;
let unmount: (() => void) | null = null;
let current = "";

async function route(): Promise<void> {
  const name = location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "lending";
  const view = VIEWS[name] ? name : "lending";
  if (view === current) return;
  current = view;
  unmount?.();
  unmount = null;
  document.querySelectorAll<HTMLAnchorElement>(".tabs a").forEach((a) => a.setAttribute("aria-current", String(a.dataset.view === view)));
  document.body.dataset.view = view;
  try {
    unmount = await (VIEWS[view] as Mount)(root);
  } catch {
    if (current !== view) return;
    root.innerHTML = `<div class="failure"><h1 class="headline">This page could not load</h1><p class="explain">Its data did not arrive. Check the connection and try again.</p><button class="btn" type="button" id="retry">Try again</button></div>`;
    root.querySelector("#retry")?.addEventListener("click", () => {
      current = "";
      void route();
    });
  }
}

window.addEventListener("hashchange", () => void route());
void route();
