// Ask Spillway: a small panel that sends a question to the agent (agent/, POST /api/ask) and shows
// the answer with the tools it used. Answers and tool names are set as text, never as HTML.

export interface AskOptions {
  /** Where the agent listens. Default /api/ask. */
  endpoint?: string;
  /** The market the reader is looking at, as an id or a pair, sent with each question. A function is read at each question. */
  market?: string | (() => string | undefined);
  /** Show the panel's own title. Off when the page already titles the section. Default on. */
  heading?: boolean;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
}

interface Reply {
  answer: string;
  tools: { name: string; summary: string }[];
}

const SUGGESTIONS: [label: string, question: string][] = [
  ["wstETH marked down 20%", "What happens to Steakhouse Prime ETH's depositors if wstETH is marked down 20%?"],
  ["Riskiest collateral", "Which collateral would hurt Monad lenders most if it failed?"],
  ["Cover for August USDC V2", "How much does cover cost for August USDC V2?"],
  ["Has the cover paid?", "Has the cover ever paid?"],
];

const MAX_QUESTION = 500;
const MAX_HISTORY = 6;
const TIMEOUT_MS = 60_000;

const STYLE_ID = "ask-spillway-style";
const CSS = `
.ask { border: 1px solid var(--hair); border-radius: var(--radius); background: var(--bg); padding: 14px 14px 12px; display: flex; flex-direction: column; gap: 10px; font-family: var(--font); color: var(--ink); }
.ask-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 8px; }
.ask-title { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.ask-sub { font-size: 12.5px; color: var(--muted); }
.ask-log { display: flex; flex-direction: column; gap: 10px; max-height: 360px; overflow-y: auto; }
.ask-log:empty { display: none; }
.ask-q { align-self: flex-end; max-width: 85%; font-size: 14px; line-height: 1.4; background: var(--surface); border-radius: var(--radius-s); padding: 8px 11px; overflow-wrap: anywhere; }
.ask-a { font-size: 14px; line-height: 1.45; text-wrap: pretty; overflow-wrap: anywhere; }
.ask-a.ask-error { color: var(--danger); }
.ask-a.ask-wait { color: var(--muted); display: flex; align-items: center; gap: 8px; }
.ask-a.ask-wait::before { content: ""; width: 24px; height: 4px; border-radius: 2px; background: var(--hair-2); animation: ask-pulse 1.4s ease-in-out infinite; }
.ask-tools { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.ask-tool { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: var(--ink-2); border: 1px solid var(--hair-2); border-radius: 999px; padding: 2px 9px; font-variant-numeric: tabular-nums; }
.ask-tool::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 1px #9cc21a inset; flex: 0 0 auto; }
.ask-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ask-chips button { font: inherit; font-size: 13px; font-weight: 500; height: 30px; border: 1px solid var(--hair-2); background: var(--bg); color: var(--ink); border-radius: 999px; padding: 0 12px; cursor: pointer; transition: border-color 120ms linear; }
.ask-chips button:hover:not(:disabled) { border-color: var(--ink); }
.ask-chips button:focus-visible { border-radius: 999px; }
.ask-chips button:disabled { color: var(--muted); cursor: default; }
.ask-form { display: flex; gap: 8px; }
.ask-form input { flex: 1; min-width: 0; height: 40px; font: inherit; font-size: 14px; padding: 0 14px; border: 1px solid var(--hair-2); border-radius: 999px; color: var(--ink); background: var(--bg); }
.ask-form input:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; border-color: var(--ink); }
.ask-form input::placeholder { color: var(--muted); }
.ask-note { font-size: 12px; color: var(--muted); margin: 0; }
@keyframes ask-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** The agent's reply, or a plain sentence saying why there is none. */
async function fetchAnswer(endpoint: string, body: unknown, signal: AbortSignal): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (err) {
    if (signal.aborted) throw new Error("That took too long. Try again.");
    throw new Error("Could not reach Ask Spillway. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => null)) as (Partial<Reply> & { error?: string }) | null;
  if (!res.ok || !data || typeof data.answer !== "string") {
    if (res.status === 429) throw new Error("Too many questions. Try again in a minute.");
    throw new Error(typeof data?.error === "string" ? data.error : "Could not get an answer. Try again.");
  }
  return { answer: data.answer, tools: Array.isArray(data.tools) ? data.tools.filter((t) => typeof t?.summary === "string") : [] };
}

export function mountAsk(el: HTMLElement, opts: AskOptions = {}): () => void {
  injectStyle();
  const endpoint = opts.endpoint ?? "/api/ask";
  const history: Turn[] = [];
  let busy = false;
  let controller: AbortController | null = null;
  let lastQuestion = "";

  const root = node("section", "ask");
  root.setAttribute("aria-label", "Ask Spillway");
  const head = node("div", "ask-head");
  head.append(node("span", "ask-title", "Ask Spillway"), node("span", "ask-sub", "Answers from the stress test and the testnet"));

  const log = node("div", "ask-log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");

  const chips = node("div", "ask-chips");
  chips.setAttribute("aria-label", "Suggested questions");
  const chipButtons = SUGGESTIONS.map(([label, question]) => {
    const b = node("button", undefined, label);
    b.type = "button";
    b.title = question;
    b.addEventListener("click", () => void submit(question));
    chips.append(b);
    return b;
  });

  const form = node("form", "ask-form");
  const input = node("input");
  input.type = "text";
  input.maxLength = MAX_QUESTION;
  input.placeholder = "Ask about a market, a vault or the cover";
  input.setAttribute("aria-label", "Your question");
  input.autocomplete = "off";
  const button = node("button", "btn", "Ask");
  button.type = "submit";
  form.append(input, button);

  const note = node("p", "ask-note", "Figures come from Spillway's engine on the 6 October 2026 Monad snapshot and from Monad testnet. Not advice.");
  root.append(...(opts.heading === false ? [] : [head]), log, chips, form, note);
  el.replaceChildren(root);

  function setBusy(on: boolean) {
    busy = on;
    root.setAttribute("aria-busy", String(on));
    button.disabled = on;
    for (const b of chipButtons) b.disabled = on;
  }

  async function submit(raw: string) {
    const question = raw.trim().slice(0, MAX_QUESTION);
    if (question === "" || busy) return;
    lastQuestion = question;
    input.value = "";
    log.append(node("div", "ask-q", question));
    const answer = node("div", "ask-a ask-wait", "Working it out");
    log.append(answer);
    log.scrollTop = log.scrollHeight;
    setBusy(true);
    controller = new AbortController();
    const timer = setTimeout(() => controller?.abort(), TIMEOUT_MS);
    try {
      const reply = await fetchAnswer(endpoint, { question, market: typeof opts.market === "function" ? opts.market() : opts.market, history: history.slice(-MAX_HISTORY) }, controller.signal);
      answer.className = "ask-a";
      answer.textContent = reply.answer;
      if (reply.tools.length > 0) {
        const used = node("div", "ask-tools");
        used.setAttribute("aria-label", "Tools used");
        for (const t of reply.tools) used.append(node("span", "ask-tool", t.summary));
        answer.append(used);
      }
      history.push({ role: "user", text: question }, { role: "assistant", text: reply.answer });
    } catch (err) {
      if (!root.isConnected) return;
      answer.className = "ask-a ask-error";
      answer.textContent = err instanceof Error ? err.message : "Could not get an answer. Try again.";
    } finally {
      clearTimeout(timer);
      controller = null;
      setBusy(false);
      log.scrollTop = log.scrollHeight;
      if (root.isConnected) input.focus({ preventScroll: true });
    }
  }

  const onSubmit = (ev: SubmitEvent) => {
    ev.preventDefault();
    void submit(input.value);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      input.value = "";
    } else if (ev.key === "ArrowUp" && input.value === "" && lastQuestion !== "") {
      // Bring back the last question to edit it.
      ev.preventDefault();
      input.value = lastQuestion;
      input.setSelectionRange(input.value.length, input.value.length);
    }
  };
  form.addEventListener("submit", onSubmit);
  input.addEventListener("keydown", onKey);

  return () => {
    controller?.abort();
    form.removeEventListener("submit", onSubmit);
    input.removeEventListener("keydown", onKey);
    root.remove();
  };
}
