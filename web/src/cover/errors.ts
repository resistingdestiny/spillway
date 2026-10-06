// One short sentence for anything a read, the wallet or a contract can throw.

import {
  BaseError,
  ChainMismatchError,
  ContractFunctionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  TimeoutError,
  UserRejectedRequestError,
  decodeErrorResult,
} from "viem";
import { usdAbi } from "../abi/usd.js";
import { tusd as fmt } from "./format.js";

const tusd = (x: unknown) => fmt(BigInt(x as bigint));

/** The contracts' custom errors, by name. `args` are the error's arguments. */
const REVERTS: Record<string, (args: readonly unknown[]) => string> = {
  BelowDust: (a) => `Nothing to pay yet: ${tusd(a[0])} is due, and claims under ${tusd(a[1])} are refused.`,
  NoLoss: () => "Nothing to pay: the depositor has been paid all it is due.",
  NoFreeCapital: () => "The vault has no capital left to pay with.",
  ClaimWindowClosed: () => "The policy's claim window has closed.",
  NotAttached: () => "Cover has not attached to this policy yet.",
  UnknownPolicy: () => "There is no such policy.",
  BorrowersNotSorted: () => "The borrower list is out of order.",
  ZeroAmount: () => "Enter an amount above zero.",
  ZeroShares: () => "That amount is too small to buy a vault share.",
  PrincipalWipedOut: () => "The vault's capital is gone, so it takes no new deposits.",
  MintCapExceeded: (a) => `One mint is capped at ${tusd(a[1])}.`,
  ERC20InsufficientBalance: () => "Not enough tUSD in this wallet. Get test dollars first.",
  ERC20InsufficientAllowance: () => "The vault is not yet approved to take that much tUSD.",
};

/** The revert's name and arguments, decoding tUSD's errors when the vault passes them up. */
function revertOf(e: ContractFunctionRevertedError): { name: string; args: readonly unknown[] } | null {
  if (e.data?.errorName) return { name: e.data.errorName, args: e.data.args ?? [] };
  if (!e.raw) return null;
  try {
    const d = decodeErrorResult({ abi: usdAbi, data: e.raw });
    return { name: d.errorName, args: d.args ?? [] };
  } catch {
    return null;
  }
}

export function plain(err: unknown): string {
  if (!(err instanceof BaseError)) return err instanceof Error ? err.message : "Something went wrong.";
  const found = (cls: new (...a: never[]) => Error) => err.walk((e) => e instanceof cls);
  const code = (c: number) => err.walk((e) => (e as { code?: unknown }).code === c) !== null;
  // EIP-1193: 4001 is a request the user turned down, -32002 one already waiting in the wallet.
  if (found(UserRejectedRequestError) || code(4001)) return "Cancelled in the wallet.";
  const revert = found(ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (revert) {
    const r = revertOf(revert);
    if (r) return REVERTS[r.name]?.(r.args) ?? `The contract refused it (${r.name}).`;
    return "The contract refused it.";
  }
  if (found(InsufficientFundsError) || /insufficient (funds|balance)/i.test(err.details ?? "")) return "This wallet needs testnet MON for gas.";
  if (found(ChainMismatchError)) return "Switch the wallet to Monad testnet first.";
  if (code(-32002)) return "The wallet already has a request open. Check it.";
  if (found(HttpRequestError) || found(TimeoutError)) return "The Monad testnet RPC did not answer. Trying again shortly.";
  return err.shortMessage || "Something went wrong.";
}
