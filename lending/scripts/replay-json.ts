// Write a replay book for the testnet: one real Monad market's largest positions, copied from a
// snapshot at its block, in the units of the testnet tokens (tUSD for the loan, a test token for the
// collateral). Dollar values and health factors are kept; amounts are multiplied by `scale`.
//
//   tsx scripts/replay-json.ts <snapshot.json> --market wstETH/WETH [--borrowers 20] [--scale 0.01] [--out file]
//
// Output shape: spillway.morpho-replay/1 (contracts/README.md).

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type AdaptersFile, type RawSnapshot, loadBook, positionsByMarket } from "../src/index.js";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] as string) : fallback;
};
const cwd = process.env.INIT_CWD ?? process.cwd();
const input = resolve(cwd, args[0] ?? "");
const pair = flag("market", "wstETH/WETH");
const nBorrowers = Number(flag("borrowers", "20"));
const scale = Number(flag("scale", "0.01"));

const raw = JSON.parse(readFileSync(input, "utf8")) as RawSnapshot;
const adaptersPath = join(dirname(input), basename(input).replace(/\.json$/, ".adapters.json"));
let adapters: AdaptersFile | undefined;
try {
  adapters = JSON.parse(readFileSync(adaptersPath, "utf8")) as AdaptersFile;
} catch {
  adapters = undefined;
}
const book = loadBook(raw, adapters);

const [collSym, loanSym] = pair.split("/");
const candidates = book.markets.filter((m) => m.collateral?.symbol === collSym && m.loan.symbol === loanSym && m.price !== null);
const byMarket = positionsByMarket(book);
const debtOf = (id: string) => (byMarket.get(id) ?? []).reduce((a, p) => a + p.borrowAssets, 0n);
const market = candidates.sort((a, b) => (debtOf(b.id) > debtOf(a.id) ? 1 : -1))[0];
if (!market || !market.collateral || market.price === null) throw new Error(`no priced market ${pair} in the snapshot`);

const loanUsd = market.loan.priceUsd ?? 0;
if (loanUsd <= 0) throw new Error(`no USD price for ${market.loan.symbol}`);
const loanDec = market.loan.decimals;
const collDec = market.collateral.decimals;
// Collateral price in loan tokens (the loader has already removed Morpho's oracle scale).
const oracleLoanPerColl = market.price;

// Testnet units: tUSD has 6 decimals, the test collateral 18.
const TUSD = 1e6;
const toTusd = (loanTokens: number) => BigInt(Math.round(loanTokens * loanUsd * scale * TUSD));
const toColl = (collTokens: number) => BigInt(Math.round(collTokens * scale * 1e9)) * 10n ** 9n;
// tUSD per test collateral, in Morpho's oracle scale: usd * 1e36 * 1e6 / 1e18.
const oraclePrice = BigInt(Math.round(oracleLoanPerColl * loanUsd * 1e12)) * 10n ** 12n;

const positions = byMarket.get(market.id) ?? [];
const borrowers = positions
  .filter((p) => p.borrowAssets > 0n)
  .sort((a, b) => (b.borrowAssets > a.borrowAssets ? 1 : b.borrowAssets < a.borrowAssets ? -1 : a.user < b.user ? -1 : 1))
  .slice(0, nBorrowers);
const suppliers = positions
  .filter((p) => p.supplyAssets > 0n)
  .sort((a, b) => (b.supplyAssets > a.supplyAssets ? 1 : b.supplyAssets < a.supplyAssets ? -1 : a.user < b.user ? -1 : 1));

// Morpho refuses a zero amount, so positions too small to show up at this scale are left out.
const seededSuppliers = suppliers.filter((p) => toTusd(Number(p.supplyAssets) / 10 ** loanDec) > 0n);
const seededBorrowers = borrowers.filter(
  (p) => toTusd(Number(p.borrowAssets) / 10 ** loanDec) > 0n && toColl(Number(p.collateral) / 10 ** collDec) > 0n,
);

const replay = {
  schema: "spillway.morpho-replay/1",
  source: {
    chainId: book.chainId,
    block: book.blocks.to.number,
    marketId: market.id,
    pair,
    scale,
    loanUsd,
    note: `The ${seededBorrowers.length} largest borrowers and every supplier of ${pair} on Monad, at block ${book.blocks.to.number}, in testnet units. Dollar values times ${scale}.`,
    borrowers: seededBorrowers.map((p) => p.user),
    suppliers: seededSuppliers.map((p) => p.user),
  },
  collateral: { name: `Test ${collSym}`, symbol: `t${collSym}`, decimals: 18 },
  lltv: market.lltvWad.toString(),
  oraclePrice: oraclePrice.toString(),
  holderIndex: 0,
  suppliers: seededSuppliers.map((p) => ({ assets: toTusd(Number(p.supplyAssets) / 10 ** loanDec).toString() })),
  borrowers: seededBorrowers.map((p) => ({
    collateral: toColl(Number(p.collateral) / 10 ** collDec).toString(),
    borrowAssets: toTusd(Number(p.borrowAssets) / 10 ** loanDec).toString(),
  })),
};

const out = resolve(cwd, flag("out", `contracts/replay/${collSym}-${loanSym}-${book.blocks.to.number}.json`));
writeFileSync(out, `${JSON.stringify(replay, null, 2)}\n`);
const debt = seededBorrowers.reduce((a, p) => a + Number(p.borrowAssets) / 10 ** loanDec, 0) * loanUsd;
console.log(`${out}: ${seededBorrowers.length} borrowers ($${Math.round(debt).toLocaleString("en-US")} at mainnet value), ${seededSuppliers.length} suppliers, scale ${scale}`);
