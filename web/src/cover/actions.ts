// What a visitor can do with a browser wallet: get test dollars, underwrite the cover, and claim
// for the depositor. Each action sends transactions through the wallet and reports their state.

import { type Hash, type PublicClient, maxUint256 } from "viem";
import { usdAbi } from "../abi/usd.js";
import { vaultAbi } from "../abi/vault.js";
import { ADDR, BORROWERS, CHAIN, FAUCET_AMOUNT, POLICY_ID, USD_DECIMALS } from "./config.js";
import { type Wallet, confirmed } from "./wallet.js";

/** One step of an action, as the page shows it. */
export interface Step {
  label: string;
  state: "waiting" | "sent" | "done" | "failed";
  hash?: Hash;
}

export type Report = (steps: Step[]) => void;

/** Sends one transaction through the wallet, then waits for it, updating `steps[i]` as it goes. */
async function run(pub: PublicClient, steps: Step[], i: number, report: Report, send: () => Promise<Hash>): Promise<void> {
  const step = steps[i] as Step;
  step.state = "waiting";
  report(steps);
  try {
    step.hash = await send();
    step.state = "sent";
    report(steps);
    await confirmed(pub, step.hash);
    step.state = "done";
    report(steps);
  } catch (e) {
    step.state = "failed";
    report(steps);
    throw e;
  }
}

/** Mints test dollars to the visitor. MockUSD lets anyone mint up to 100,000 a call. */
export async function getTestDollars(pub: PublicClient, w: Wallet, report: Report): Promise<void> {
  const steps: Step[] = [{ label: `Mint ${Number(FAUCET_AMOUNT) / 10 ** USD_DECIMALS} test dollars`, state: "waiting" }];
  await run(pub, steps, 0, report, () =>
    w.client.writeContract({ chain: CHAIN, account: w.account, address: ADDR.usd, abi: usdAbi, functionName: "mint", args: [w.account, FAUCET_AMOUNT] }),
  );
}

/** Deposits capital into the cover vault, approving the vault first if it needs more allowance. */
export async function underwrite(pub: PublicClient, w: Wallet, amount: bigint, report: Report): Promise<void> {
  const allowance = (await pub.readContract({ address: ADDR.usd, abi: usdAbi, functionName: "allowance", args: [w.account, ADDR.vault] })) as bigint;
  const steps: Step[] = [
    ...(allowance < amount ? [{ label: "Let the vault take test dollars", state: "waiting" as const }] : []),
    { label: "Deposit into the cover vault", state: "waiting" },
  ];
  let i = 0;
  if (allowance < amount) {
    await run(pub, steps, i++, report, () =>
      w.client.writeContract({ chain: CHAIN, account: w.account, address: ADDR.usd, abi: usdAbi, functionName: "approve", args: [ADDR.vault, maxUint256] }),
    );
  }
  await run(pub, steps, i, report, () =>
    w.client.writeContract({ chain: CHAIN, account: w.account, address: ADDR.vault, abi: vaultAbi, functionName: "deposit", args: [amount] }),
  );
}

/**
 * Claims the shortfall Morpho has not written off, for policy 1. Anyone may call it; the vault pays
 * the policyholder, never the caller. Passes the replayed borrowers in the order the vault requires.
 */
export async function claimForDepositor(pub: PublicClient, w: Wallet, report: Report): Promise<void> {
  const steps: Step[] = [{ label: "Claim the proven shortfall for the depositor", state: "waiting" }];
  await run(pub, steps, 0, report, () =>
    w.client.writeContract({ chain: CHAIN, account: w.account, address: ADDR.vault, abi: vaultAbi, functionName: "claimShortfall", args: [POLICY_ID, BORROWERS] }),
  );
}
