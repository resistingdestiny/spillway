// Who loses when a market takes bad debt.
//
// Morpho writes bad debt off against totalSupplyAssets. Supply shares do not change, so every share
// loses the same amount and each supplier's loss is its share of the market's supply shares times the
// bad debt. An unrealised loss is split the same way: it is what each supplier would lose if the loss
// were realised today.
//
// The denominator is the sum of the suppliers' shares in the snapshot, so the split adds up to the
// whole loss. The fidelity check holds that sum within 1% of the market's own supplyShares.

import { type LendingBook, type Position, vaultOf } from "./snapshot.js";

export interface SupplierShare {
  supplier: string;
  /** The vault this supplier supplies for, directly or as its adapter, or null for anyone else. */
  vault: string | null;
  vaultName: string | null;
  shares: bigint;
  /** Fraction of the market's supply shares. */
  share: number;
  /** Supplied, in loan tokens. */
  supplied: number;
}

export function supplierShares(book: LendingBook, positions: Position[], loanDecimals: number): SupplierShare[] {
  const suppliers = positions.filter((p) => p.supplyShares > 0n);
  const total = suppliers.reduce((a, p) => a + p.supplyShares, 0n);
  return suppliers.map((p) => {
    const v = vaultOf(book, p.user);
    return {
      supplier: p.user,
      vault: v?.address ?? null,
      vaultName: v?.name ?? null,
      shares: p.supplyShares,
      share: Number(p.supplyShares) / Number(total),
      supplied: Number(p.supplyAssets) / 10 ** loanDecimals,
    };
  });
}

export interface SupplierLoss {
  supplier: string;
  vault: string | null;
  vaultName: string | null;
  loss: number;
}

/** A market's loss split across its suppliers by supply shares. */
export function splitLoss(loss: number, shares: SupplierShare[]): SupplierLoss[] {
  return shares.map((s) => ({ supplier: s.supplier, vault: s.vault, vaultName: s.vaultName, loss: loss * s.share }));
}

/** The same split, summed by vault. Suppliers that are not a known vault are summed under null. */
export function lossByVault(loss: number, shares: SupplierShare[]): Map<string | null, number> {
  const out = new Map<string | null, number>();
  for (const s of splitLoss(loss, shares)) out.set(s.vault, (out.get(s.vault) ?? 0) + s.loss);
  return out;
}
