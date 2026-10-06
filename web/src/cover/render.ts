// Each block of the Cover view as one plain sentence and its figures, from live state.

import { COLLATERAL_DECIMALS, FRESH_SHARE_PRICE, ORACLE_START, REPLAY, USD_DECIMALS, VIRTUAL_ASSETS, VIRTUAL_SHARES } from "./config.js";
import type { ClaimEvent } from "./events.js";
import { addrLink, day, int, pct, tusd, txLink } from "./format.js";
import { type Live, toAssetsDown } from "./read.js";

export interface Block {
  sentence: string;
  rows: [label: string, value: string][];
}

export const dl = (rows: Block["rows"]): string => rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");

/** tUSD per twstETH from a Morpho oracle price. */
const oracleTusd = (price: bigint) => Number(price) / 10 ** (36 + USD_DECIMALS - COLLATERAL_DECIMALS);
/** Supply share price relative to a fresh market, with Morpho's virtual shares and assets. */
const sharePriceOf = (assets: bigint, shares: bigint) => Number(((assets + VIRTUAL_ASSETS) * 10n ** 36n) / (shares + VIRTUAL_SHARES)) / Number(FRESH_SHARE_PRICE);
const paid = (s: string) => `<span class="paid">${s}</span>`;

export function headline(live: Live): string {
  return live.policy.paid > 0n
    ? `Spillway has paid the main depositor <b>${tusd(live.policy.paid)}</b> for a loss Morpho has not written off.`
    : "Spillway covers the main depositor of a Morpho market on Monad testnet.";
}

export const REPLAY_NOTE = `This market is a replay of Monad's real ${REPLAY.pair} book at mainnet block ${int(REPLAY.block)}, at ${pct(REPLAY.scale, 0)} scale, on our own Morpho Blue with an oracle we control.`;

export function marketBlock(live: Live): Block {
  const now = oracleTusd(live.oracle);
  const start = oracleTusd(ORACLE_START);
  const fall = 1 - now / start;
  const sentence =
    live.unhealthy > 0
      ? `Our oracle has marked twstETH down ${pct(fall)}, and nobody has liquidated the ${live.unhealthy} borrowers that leaves unhealthy, so the loss is real but not written off.`
      : "Every listed borrower's collateral covers its debt at the oracle, so nobody can lose yet.";
  const priceAtStart = sharePriceOf(live.policy.startSupplyAssets, live.policy.startSupplyShares);
  return {
    sentence,
    rows: [
      ["Supplied", tusd(live.market.supplyAssets)],
      ["Borrowed", tusd(live.market.borrowAssets)],
      ["Supply share price", `${(Number(live.sharePrice) / Number(FRESH_SHARE_PRICE)).toFixed(7)}<br><span class="muted">${priceAtStart.toFixed(7)} when cover attached. It falls only when Morpho writes off a loss.</span>`],
      ["twstETH at the oracle", `${now.toLocaleString("en-US", { maximumFractionDigits: 2 })} tUSD<br><span class="muted">${start.toLocaleString("en-US", { maximumFractionDigits: 2 })} at the replay's start, ${fall >= 0 ? "−" : "+"}${pct(Math.abs(fall))}</span>`],
      ["Unhealthy borrowers", `${live.unhealthy} of ${live.borrowing}`],
      ["Shortfall at the oracle", `<b>${tusd(live.shortfall)}</b><br><span class="muted">debt above collateral value, summed over borrowers</span>`],
    ],
  };
}

export function vaultBlock(live: Live): Block {
  const v = live.vault;
  return {
    sentence: "Underwriters put up capital that backs every policy's limit in full, and earn the premium policyholders pay.",
    rows: [
      ["Capital", `${tusd(v.capital)}<br><span class="muted">pays claims, never the premium</span>`],
      ["Backing policy limits", tusd(v.activeLimit)],
      ["Free for new cover", tusd(v.capacity)],
      ["Premium, this market", `${pct(Number(v.premiumBps) / 10_000, 2)} of the limit a year`],
      ["Paid out", paid(tusd(v.paidOut))],
    ],
  };
}

export function policyBlock(live: Live): Block {
  const p = live.policy;
  const covered = toAssetsDown(p.coveredShares, p.startSupplyAssets, p.startSupplyShares);
  return {
    sentence: "Policy 1 pays its holder the larger of the loss in the share price and its part of the shortfall, less what it has already been paid.",
    rows: [
      ["Holder", `${addrLink(p.holder)}<br><span class="muted">the market's main depositor</span>`],
      ["Covers", `supply worth ${tusd(covered)} at the start`],
      ["Limit", tusd(p.limit)],
      ["Deductible", tusd(p.deductible)],
      ["Paid so far", paid(tusd(p.paid))],
      ["Due on the shortfall", tusd(live.claimableShortfall)],
      ["Due on the share price", tusd(live.claimable)],
      ["Cover ends", day(p.end)],
    ],
  };
}

export function claimsBlock(last: { Claimed: ClaimEvent | null; ShortfallClaimed: ClaimEvent | null }): Block {
  const s = last.ShortfallClaimed;
  const c = last.Claimed;
  return {
    sentence: "Each payment is a transaction on Monad testnet, and anyone could have sent it.",
    rows: [
      [
        "Shortfall claim",
        s ? `${paid(tusd(s.amount))} on a ${tusd(s.shortfall ?? 0n)} shortfall, block ${int(s.block)}<br>${txLink(s.tx)}` : "None yet.",
      ],
      [
        "Share price claim",
        c ? `${paid(tusd(c.amount))}, block ${int(c.block)}<br>${txLink(c.tx)}` : `None yet.<br><span class="muted">It pays once Morpho writes the loss off, and nothing has been written off.</span>`,
      ],
    ],
  };
}
