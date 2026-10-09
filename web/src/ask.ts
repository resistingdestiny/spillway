// The floating Ask button on every page. It opens Ask Spillway in a panel, mounting the widget on
// first open, and sends whatever the current page says the reader is looking at.

import { mountAsk } from "./agent/widget.js";

let context: (() => string | undefined) | null = null;

/** Set what the current page is about, or clear it with null. */
export function setAskContext(fn: (() => string | undefined) | null): void {
  context = fn;
}

const CLOSE = `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

export function mountAskButton(): void {
  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "ask-fab";
  fab.setAttribute("aria-expanded", "false");
  fab.setAttribute("aria-controls", "ask-panel");
  fab.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg><span>Ask</span>`;

  const panel = document.createElement("div");
  panel.className = "ask-sheet";
  panel.id = "ask-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Ask Spillway");
  panel.innerHTML = `<div class="ask-sheet-head"><span class="section">Ask Spillway</span><button type="button" class="close" aria-label="Close">${CLOSE}</button></div><div class="ask-sheet-body"></div>`;
  document.body.append(panel, fab);

  let mounted = false;
  const set = (open: boolean) => {
    panel.hidden = !open;
    fab.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("ask-open", open);
    if (open && !mounted) {
      mounted = true;
      mountAsk(panel.querySelector(".ask-sheet-body") as HTMLElement, { heading: false, market: () => context?.() });
    }
    if (open) panel.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    else fab.focus({ preventScroll: true });
  };
  fab.addEventListener("click", () => set(panel.hidden !== false));
  (panel.querySelector(".close") as HTMLElement).addEventListener("click", () => set(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) set(false);
  });
}
