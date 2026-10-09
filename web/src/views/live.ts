// The live cover on Monad testnet: the replay market on our Morpho Blue, the vault, policy 1
// and its claims, read from the chain every 10 seconds. Fills the
// checker's testnet steps (the payout and the wallet actions) and the proof drawer. Loaded on demand, so
// viem is only fetched by visitors who open the checker.

import { type Step, claimForDepositor, getTestDollars, underwrite } from "../cover/actions.js";
import { CHAIN, DEFAULT_DEPOSIT, LOG_RANGE, MON_FAUCET, POLL_MS, USD_DECIMALS } from "../cover/config.js";
import { plain } from "../cover/errors.js";
import { type ClaimEvent, claimsBetween, knownClaims, latest } from "../cover/events.js";
import { int, shortAddr, tusd, txLink } from "../cover/format.js";
import { type Live, publicClient, readLive } from "../cover/read.js";
import { type Block, REPLAY_NOTE, claimsBlock, dl, heroStats, marketBlock, policyBlock, vaultBlock } from "../cover/render.js";
import { type Wallet, connect, injected, reconnect, switchToMonad } from "../cover/wallet.js";

// The proof first: what was paid, then the loss behind it, the policy and the capital.
const BLOCKS = [
  ["claims", "Claims paid"],
  ["market", "The market"],
  ["policy", "Policy 1"],
  ["vault", "The cover vault"],
] as const;

const SKELETON_ROWS = `<div class="row"><dt><span class="skeleton" style="width:7em"></span></dt><dd><span class="skeleton" style="width:9em"></span></dd></div>`.repeat(3);
const small = (v: string) => v.replace(/ tUSD$/, "<small>tUSD</small>");

const CARD = `
  <div class="live-head">
    <span class="overline live" id="live-sub">Reading Monad testnet</span>
  </div>
  <div class="live-paid">
    <span class="k">Paid to the covered depositor so far</span>
    <span class="v" id="live-paid"><span class="skeleton" style="width:6em"></span></span>
  </div>
  <p class="status" id="live-error" role="status" hidden></p>
  <ol class="try-steps">
    <li>
      <div class="try-text"><b>Connect a wallet</b><span class="muted" id="live-wallet"></span></div>
      <div class="actions"><button type="button" id="live-connect">Connect wallet</button></div>
    </li>
    <li>
      <div class="try-text"><b>Get test dollars</b><span class="muted">Free tUSD to try the cover with.</span></div>
      <div class="actions"><button type="button" class="secondary" id="live-faucet" disabled>Get 10,000 test dollars</button></div>
    </li>
    <li>
      <div class="try-text"><b>Back the cover</b><span class="muted">Your tUSD pays claims and earns the premium.</span></div>
      <div class="actions">
        <label class="amount">Amount <input id="live-amount" type="number" min="1" step="1" inputmode="numeric" value="${DEFAULT_DEPOSIT}" /> tUSD</label>
        <button type="button" class="secondary" id="live-underwrite" disabled>Back the cover</button>
      </div>
    </li>
    <li>
      <div class="try-text"><b>Pay the covered depositor</b><span class="muted">Anyone can send the claim. The contract checks the loss from Morpho's data and pays.</span></div>
      <div class="actions"><button type="button" class="secondary" id="live-claim" disabled>Send the claim</button></div>
    </li>
  </ol>
  <ol class="steps" id="live-steps"></ol>`;

const PROOF = `
  <div class="hero stats" id="proof-hero" aria-live="polite">
    ${["Paid to the depositor", "Shortfall at the oracle", "Unhealthy borrowers"].map((k, i) => `<div class="stat${i === 0 ? " lime" : ""}"><span class="k">${k}</span><span class="v"><span class="skeleton"></span></span><span class="sub">&nbsp;</span></div>`).join("")}
  </div>
  <p class="note">${REPLAY_NOTE}</p>
  ${BLOCKS.map(([id, title]) => `<section class="card" aria-labelledby="proof-${id}-h"><h3 class="section" id="proof-${id}-h">${title}</h3><p class="explain" id="proof-${id}-s"><span class="skeleton" style="width:80%"></span></p><dl class="rows" id="proof-${id}">${SKELETON_ROWS}</dl></section>`).join("")}`;

export async function mountLive(card: HTMLElement, proof: HTMLElement): Promise<() => void> {
  card.innerHTML = CARD;
  proof.innerHTML = PROOF;
  const $ = <T extends HTMLElement>(id: string) => (card.querySelector(`#${id}`) ?? proof.querySelector(`#${id}`)) as T;
  const pub = publicClient();

  let live: Live | null = null;
  let claims: ClaimEvent[] = [];
  let known = false;
  let scanned: bigint | null = null;
  let readAt = 0;
  let busy = false;

  function block(id: string, b: Block): void {
    $(`proof-${id}-s`).textContent = b.sentence;
    $(`proof-${id}`).innerHTML = dl(b.rows);
  }

  function age(): void {
    if (!live) return;
    const s = Math.round((Date.now() - readAt) / 1000);
    $("live-sub").textContent = `Live on Monad testnet, block ${int(live.block)}, ${s < 2 ? "just now" : `${s} s ago`}`;
  }

  function draw(): void {
    if (!live) return;
    $("live-paid").innerHTML = small(tusd(live.policy.paid));
    $("proof-hero").innerHTML = heroStats(live)
      .map(([k, v, sub], i) => `<div class="stat${i === 0 && live && live.policy.paid > 0n ? " lime" : ""}"><span class="k">${k}</span><span class="v">${small(v)}</span><span class="sub">${sub}</span></div>`)
      .join("");
    block("market", marketBlock(live));
    block("vault", vaultBlock(live));
    block("policy", policyBlock(live));
    block("claims", claimsBlock(latest(claims)));
    age();
  }

  function fail(message: string | null): void {
    const el = $("live-error");
    el.hidden = message === null;
    el.textContent = message ?? "";
    if (message !== null && !live) $("live-sub").textContent = "Monad testnet did not answer. Trying again shortly";
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
  const buttons = ["live-faucet", "live-underwrite", "live-claim"] as const;

  function walletLine(): void {
    const el = $("live-wallet");
    if (!injected()) {
      el.innerHTML = "Install a browser wallet such as MetaMask to try it.";
      ($("live-connect") as HTMLButtonElement).disabled = true;
      return;
    }
    if (!wallet) {
      el.innerHTML = `Gas is free testnet MON from <a href="${MON_FAUCET}" target="_blank" rel="noopener">Monad's faucet</a>.`;
      return;
    }
    const onMonad = wallet.chainId === CHAIN.id;
    el.innerHTML = `Connected as <code>${shortAddr(wallet.account)}</code>${onMonad ? " on Monad testnet." : ". Switch to Monad testnet to go on."}`;
    $("live-connect").textContent = onMonad ? "Connected" : "Switch to Monad testnet";
    for (const id of buttons) ($(id) as HTMLButtonElement).disabled = acting || !onMonad;
    ($("live-connect") as HTMLButtonElement).disabled = acting || onMonad;
  }

  function showSteps(steps: Step[]): void {
    const word = { waiting: "Waiting for the wallet", sent: "Sent, waiting for a block", done: "Done", failed: "Failed" };
    $("live-steps").innerHTML = steps
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
  $("live-connect").addEventListener("click", () => void onConnect());
  $("live-faucet").addEventListener("click", () => void act(() => getTestDollars(pub, wallet as Wallet, showSteps)));
  $("live-claim").addEventListener("click", () => void act(() => claimForDepositor(pub, wallet as Wallet, showSteps)));
  $("live-underwrite").addEventListener("click", () => {
    const whole = Math.floor(Number(($("live-amount") as HTMLInputElement).value));
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
  void poll();
  return () => {
    clearInterval(timer);
    clearInterval(ticker);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
