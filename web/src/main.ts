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
  unmount = await (VIEWS[view] as Mount)(root);
}

window.addEventListener("hashchange", () => void route());
void route();
