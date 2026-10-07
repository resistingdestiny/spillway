// The live cover on Monad testnet: the replay market on our Morpho Blue, the vault, policy 1
// and its claims, read from the chain every 10 seconds.

import { LOG_RANGE, POLL_MS } from "../cover/config.js";
import { type ClaimEvent, claimsBetween, knownClaims, latest } from "../cover/events.js";
import { plain } from "../cover/errors.js";
import { int } from "../cover/format.js";
import { type Live, publicClient, readLive } from "../cover/read.js";
import { type Block, REPLAY_NOTE, claimsBlock, dl, headline, heroStats, marketBlock, policyBlock, vaultBlock } from "../cover/render.js";
import { type Step, claimForDepositor, getTestDollars, underwrite } from "../cover/actions.js";
import { CHAIN, DEFAULT_DEPOSIT, MON_FAUCET, USD_DECIMALS } from "../cover/config.js";
import { shortAddr, txLink } from "../cover/format.js";
import { type Wallet, connect, injected, reconnect, switchToMonad } from "../cover/wallet.js";

// The proof first: what was paid, then the loss behind it, the policy and the capital.
const BLOCKS = [
  ["claims", "Claims paid"],
  ["market", "The market"],
  ["policy", "Policy 1"],
  ["vault", "The cover vault"],
] as const;

const SKELETON_ROWS = `<div class="row"><dt><span class="skeleton" style="width:7em"></span></dt><dd><span class="skeleton" style="width:9em"></span></dd></div>`.repeat(3);

const VIEW = `
  <div class="page">
    <div class="overline live" id="cov-sub">Reading Monad testnet</div>
    <h1 class="headline" id="cov-headline"><span class="skeleton" style="width:90%"></span><span class="skeleton" style="width:55%"></span></h1>
    <div class="hero stats" id="cov-hero" aria-live="polite">
      ${["Paid to the depositor", "Shortfall at the oracle", "Unhealthy borrowers"].map((k, i) => `<div class="stat${i === 0 ? " lime" : ""}"><span class="k">${k}</span><span class="v"><span class="skeleton"></span></span><span class="sub">&nbsp;</span></div>`).join("")}
    </div>
    <p class="note">${REPLAY_NOTE}</p>
    <p class="status" id="cov-error" role="status" hidden></p>
    ${BLOCKS.map(([id, title]) => `<section class="card" aria-labelledby="cov-${id}-h"><h2 class="section" id="cov-${id}-h">${title}</h2><p class="explain" id="cov-${id}-s"><span class="skeleton" style="width:80%"></span></p><dl class="rows" id="cov-${id}">${SKELETON_ROWS}</dl></section>`).join("")}
    <section class="card try" aria-labelledby="cov-try-h">
      <h2 class="section" id="cov-try-h">Try it</h2>
      <p class="explain">With a browser wallet on Monad testnet you can underwrite the cover with test dollars, or claim for the depositor. A claim pays the depositor, never the caller. Gas needs testnet MON from <a href="${MON_FAUCET}" target="_blank" rel="noopener">Monad's faucet</a>.</p>
      <p class="explain wallet" id="cov-wallet"></p>
      <div class="actions">
        <button type="button" id="cov-connect">Connect wallet</button>
        <button type="button" class="secondary" id="cov-faucet" disabled>Get 10,000 test dollars</button>
      </div>
      <div class="actions">
        <label class="amount">Deposit <input id="cov-amount" type="number" min="1" step="1" inputmode="numeric" value="${DEFAULT_DEPOSIT}" /> tUSD</label>
        <button type="button" class="secondary" id="cov-underwrite" disabled>Underwrite</button>
        <button type="button" class="secondary" id="cov-claim" disabled>Claim for the depositor</button>
      </div>
      <ol class="steps" id="cov-steps"></ol>
    </section>
  </div>`;

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
    $("cov-hero").innerHTML = heroStats(live)
      .map(([k, v, sub], i) => `<div class="stat${i === 0 && live && live.policy.paid > 0n ? " lime" : ""}"><span class="k">${k}</span><span class="v">${v.replace(/ tUSD$/, "<small>tUSD</small>")}</span><span class="sub">${sub}</span></div>`)
      .join("");
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
    if (message !== null && !live) $("cov-sub").textContent = "Monad testnet did not answer. Trying again shortly";
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

  // ---------------------------------------------------------------- the wallet and its actions
  let wallet: Wallet | null = null;
  let acting = false;
  const buttons = ["cov-faucet", "cov-underwrite", "cov-claim"] as const;

  function walletLine(): void {
    const el = $("cov-wallet");
    if (!injected()) {
      el.textContent = "No browser wallet found. Install one such as MetaMask to try the actions.";
      ($("cov-connect") as HTMLButtonElement).disabled = true;
      return;
    }
    if (!wallet) {
      el.textContent = "Wallet not connected.";
      return;
    }
    const onMonad = wallet.chainId === CHAIN.id;
    el.innerHTML = `Connected as <code>${shortAddr(wallet.account)}</code>${onMonad ? " on Monad testnet." : ". Switch to Monad testnet to act."}`;
    $("cov-connect").textContent = onMonad ? "Connected" : "Switch to Monad testnet";
    for (const id of buttons) ($(id) as HTMLButtonElement).disabled = acting || !onMonad;
    ($("cov-connect") as HTMLButtonElement).disabled = acting || onMonad;
  }

  function showSteps(steps: Step[]): void {
    const word = { waiting: "Waiting for the wallet", sent: "Sent, waiting for a block", done: "Done", failed: "Failed" };
    $("cov-steps").innerHTML = steps
      .map((s) => `<li class="step ${s.state}">${s.label}: ${word[s.state]}${s.hash ? ` (${txLink(s.hash)})` : ""}</li>`)
      .join("");
  }

  async function act(fn: () => Promise<void>): Promise<void> {
    if (!wallet || acting) return;
    acting = true;
    walletLine();
    fail(null);
    try {
      await fn();
      await poll();
    } catch (e) {
      fail(plain(e));
    } finally {
      acting = false;
      walletLine();
    }
  }

  const onConnect = async () => {
    const provider = injected();
    if (!provider) return;
    try {
      wallet = wallet ?? (await connect(provider));
      if (wallet.chainId !== CHAIN.id) await switchToMonad(wallet);
      fail(null);
    } catch (e) {
      fail(plain(e));
    }
    walletLine();
  };
  $("cov-connect").addEventListener("click", () => void onConnect());
  $("cov-faucet").addEventListener("click", () => void act(() => getTestDollars(pub, wallet as Wallet, showSteps)));
  $("cov-claim").addEventListener("click", () => void act(() => claimForDepositor(pub, wallet as Wallet, showSteps)));
  $("cov-underwrite").addEventListener("click", () => {
    const whole = Math.floor(Number(($("cov-amount") as HTMLInputElement).value));
    if (!(whole > 0)) {
      fail("Enter a deposit of at least 1 tUSD.");
      return;
    }
    void act(() => underwrite(pub, wallet as Wallet, BigInt(whole) * 10n ** BigInt(USD_DECIMALS), showSteps));
  });
  const provider = injected();
  if (provider) {
    reconnect(provider)
      .then((w) => {
        wallet = w;
        walletLine();
      })
      .catch(() => walletLine());
    provider.on?.("accountsChanged", () => void reconnect(provider).then((w) => ((wallet = w), walletLine())));
    provider.on?.("chainChanged", () => void reconnect(provider).then((w) => ((wallet = w), walletLine())));
  }
  walletLine();

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
