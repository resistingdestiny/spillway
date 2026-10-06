// A browser wallet (EIP-1193, as MetaMask injects it). The page never sees a key: the
// wallet signs every transaction itself and the page only asks.

import { type Address, BaseError, type EIP1193Provider, type Hash, type PublicClient, type TransactionReceipt, type WalletClient, createWalletClient, custom } from "viem";
import { CHAIN, RECEIPT_POLL_MS } from "./config.js";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export interface Wallet {
  provider: EIP1193Provider;
  client: WalletClient;
  account: Address;
  chainId: number;
}

export const injected = (): EIP1193Provider | null => window.ethereum ?? null;

/** Asks the wallet for an account. */
export async function connect(provider: EIP1193Provider): Promise<Wallet> {
  const client = createWalletClient({ chain: CHAIN, transport: custom(provider) });
  const [account] = await client.requestAddresses();
  if (!account) throw new Error("The wallet shared no account.");
  return { provider, client, account, chainId: await client.getChainId() };
}

/** The account the wallet already shares with this page, without a prompt. */
export async function reconnect(provider: EIP1193Provider): Promise<Wallet | null> {
  const client = createWalletClient({ chain: CHAIN, transport: custom(provider) });
  const [account] = await client.getAddresses();
  return account ? { provider, client, account, chainId: await client.getChainId() } : null;
}

/** Switches the wallet to Monad testnet, adding the network first if it does not know it. */
export async function switchToMonad(w: Wallet): Promise<void> {
  try {
    await w.client.switchChain({ id: CHAIN.id });
  } catch (e) {
    // EIP-3326: 4902 means the wallet has no such chain. MetaMask switches once it adds one.
    if (!(e instanceof BaseError && e.walk((x) => (x as { code?: unknown }).code === 4902))) throw e;
    await w.client.addChain({ chain: CHAIN });
  }
  w.chainId = await w.client.getChainId();
}

/** Waits for a sent transaction, and fails if it reverted on chain. */
export async function confirmed(pub: PublicClient, hash: Hash): Promise<TransactionReceipt> {
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: RECEIPT_POLL_MS, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error("The transaction reverted on chain.");
  return receipt;
}
