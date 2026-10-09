import { mountApp } from "./views/app.js";
import { mountLanding } from "./views/landing.js";
import { mountPerpl } from "./views/perpl.js";

type Mount = (root: HTMLElement) => Promise<() => void>;
const VIEWS: Record<string, Mount> = { landing: mountLanding, app: mountApp, perpl: mountPerpl };
/** Routes from before the app was one page, and where they now open. */
const MOVED: Record<string, string> = { lending: "#/app", cover: "#/app/proof", verify: "#/app/verify" };

const root = document.getElementById("view") as HTMLElement;
let unmount: (() => void) | null = null;
let current = "";
/** A landing section to scroll to once the landing page has mounted. */
let pendingScroll: string | null = null;

function scrollToSection(id: string): void {
  const el = document.getElementById(`sec-${id}`);
  if (!el) return;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
}

async function route(): Promise<void> {
  const name = location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "landing";
  const moved = MOVED[name];
  if (moved) {
    location.replace(moved);
    return;
  }
  const view = VIEWS[name] ? name : "landing";
  if (view === current) return;
  current = view;
  unmount?.();
  unmount = null;
  document.querySelectorAll<HTMLAnchorElement>(".top a[data-view]").forEach((a) => a.setAttribute("aria-current", String(a.dataset.view === view)));
  document.body.dataset.view = view;
  if (!pendingScroll) window.scrollTo(0, 0);
  try {
    const done = await (VIEWS[view] as Mount)(root);
    // The visitor may have moved on while it loaded.
    if (current === view) unmount = done;
    else done();
    if (current === view && pendingScroll) {
      scrollToSection(pendingScroll);
      pendingScroll = null;
    }
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

// Header links to landing sections, and the phone menu.
const menu = document.getElementById("menu-btn") as HTMLButtonElement;
const setMenu = (open: boolean) => {
  menu.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("menu-open", open);
};
menu.addEventListener("click", () => setMenu(menu.getAttribute("aria-expanded") !== "true"));
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a");
  if (!a) return;
  if (a.closest(".top")) setMenu(false);
  const id = a.dataset.scroll;
  if (!id) return;
  e.preventDefault();
  if (current === "landing") scrollToSection(id);
  else {
    pendingScroll = id;
    location.hash = "#/";
  }
});
void route();
