// The live cover on Monad testnet: the replay market on our Morpho Blue, the vault, policy 1
// and its claims, read from the chain every 10 seconds.

import { LOG_RANGE, POLL_MS } from "../cover/config.js";
import { type ClaimEvent, claimsBetween, knownClaims, latest } from "../cover/events.js";
import { plain } from "../cover/errors.js";
import { int } from "../cover/format.js";
import { type Live, publicClient, readLive } from "../cover/read.js";
import { type Block, REPLAY_NOTE, claimsBlock, dl, headline, marketBlock, policyBlock, vaultBlock } from "../cover/render.js";

const BLOCKS = [
  ["market", "The market"],
  ["vault", "The cover vault"],
  ["policy", "Policy 1"],
  ["claims", "Claims paid"],
] as const;

const VIEW = `
  <div class="market" id="cov-sub">Reading Monad testnet…</div>
  <p class="headline" id="cov-headline"></p>
  <p class="note">${REPLAY_NOTE}</p>
  <p class="status" id="cov-error" role="status" hidden></p>
  ${BLOCKS.map(([id, title]) => `<h2 class="section">${title}</h2><p class="explain" id="cov-${id}-s"></p><dl class="manifest" id="cov-${id}"></dl>`).join("")}`;

export async function mountCover(root: HTMLElement): Promise<() => void> {
  root.innerHTML = VIEW;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
  const pub = publicClient();

  let live: Live | null = null;
  let claims: ClaimEvent[] = [];
  let known = false;
  let scanned: bigint | null = null;
  let readAt = 0;
  let busy = false;

  function block(id: string, b: Block): void {
    $(`cov-${id}-s`).textContent = b.sentence;
    $(`cov-${id}`).innerHTML = dl(b.rows);
  }

  function age(): void {
    if (!live) return;
    const s = Math.round((Date.now() - readAt) / 1000);
    $("cov-sub").textContent = `Live from Monad testnet, block ${int(live.block)}, read ${s < 2 ? "just now" : `${s} s ago`}`;
  }

  function draw(): void {
    if (!live) return;
    $("cov-headline").innerHTML = headline(live);
    block("market", marketBlock(live));
    block("vault", vaultBlock(live));
    block("policy", policyBlock(live));
    block("claims", claimsBlock(latest(claims)));
    age();
  }

  function fail(message: string | null): void {
    const el = $("cov-error");
    el.hidden = message === null;
    el.textContent = message ?? "";
  }

  // Two requests a poll, a multicall and a log query over the blocks since the last one.
  async function poll(): Promise<void> {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const [next, history] = await Promise.all([readLive(pub, null), known ? Promise.resolve([]) : knownClaims(pub)]);
      const fresh = await claimsBetween(pub, scanned === null ? next.block - LOG_RANGE + 1n : scanned + 1n, next.block);
      claims = [...claims, ...history, ...fresh];
      known = true;
      scanned = next.block;
      live = next;
      readAt = Date.now();
      fail(null);
      draw();
    } catch (e) {
      fail(plain(e));
    } finally {
      busy = false;
    }
  }

  const onVisible = () => {
    if (!document.hidden && Date.now() - readAt >= POLL_MS) void poll();
  };
  document.addEventListener("visibilitychange", onVisible);
  const timer = setInterval(() => void poll(), POLL_MS);
  const ticker = setInterval(age, 1000);
  await poll();
  return () => {
    clearInterval(timer);
    clearInterval(ticker);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
