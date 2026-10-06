# Spillway

Cover for Monad lending depositors, priced from a public stress test anyone can rerun, and paid from chain state without a vote.

When a borrower's collateral fails, the loss lands on the people who deposited. Spillway tests every Morpho market on Monad position by position, prices cover for each vault's depositors from that test, and pays when Morpho's own data shows the loss.

Built for the Monad Metropolis hackathon.

## What the test shows (Monad, 6 October 2026)

- $131.8M is borrowed across 92 Morpho markets on Monad.
- Six of the eight largest markets price their collateral from an exchange rate, a vault's share price or an issuer's reported value, and the other two from a time-weighted price of a Pendle PT. A market sell-off of the collateral does not reach the first six. A loss arrives when the issuer marks the collateral down, in one step.
- Exits are thin. Selling $100k of wstETH on Monad costs 18.6%, and several collateral tokens have no route at all. After a markdown, liquidators can sell little inside their incentive, so most of the loss is never written off on chain.
- In wstETH/WETH, the largest market, a 25% markdown of wstETH leaves $5.9M unpaid, almost all of it unwritten. Steakhouse Prime ETH supplies 97.6% of that market.
- Priced from how often each kind of collateral has failed since 2022, cover for Steakhouse Prime ETH's depositors costs 0.71% of supply a year.

Sources and method are in `docs/RESEARCH.md`. Every number names its block and input hash, and reruns byte for byte.

## How it works

1. **Read.** A dated snapshot of every Morpho market and position on Monad (`engine/scripts/snapshot-morpho.ts`, archived daily in `fixtures/morpho/`). Health factors match Morpho's for every borrower.
2. **Test.** `lending/` marks one collateral token down at a time, lets liquidators sell only what Monad's exchanges can absorb inside their incentive, and splits the bad debt across each market's suppliers by vault.
3. **Price.** Expected loss to each vault's depositors from the failure rate and severity of each kind of collateral, plus a risk load and a capital charge.
4. **Pay.** `contracts/src/lending/MorphoCoverVault.sol` pays a policyholder when the market's supply share price falls (bad debt written off), and on a shortfall anyone can prove from Morpho's positions and the market's own oracle (bad debt not yet written off). No keeper to trust and no vote.

On Monad testnet, our own Morpho Blue holds the real wstETH/WETH book from Monad block 111,058,632 at 1% scale. A 25% markdown leaves 16 of 17 borrowers underwater with nobody able to liquidate. Anyone can then prove the 59,053.92 tUSD shortfall from Morpho's positions, and the cover paid the main depositor its share, 57,634.68 tUSD, within 4 cents of the engine's forecast ([claim transaction](https://testnet.monadscan.com/tx/0x78d33f221e1a5512211d2bc830ca0ab1236cab0816ed7940fa5f0477580bba1a), details in `contracts/replay/testnet-wstETH-WETH-unrealised-25.json`). On a local chain, a 10% markdown with liquidations leaves 11,242.61 tUSD written off, the engine's figure to the cent.

| Lending contract on Monad testnet | Address |
| --- | --- |
| MorphoCoverVault | `0x8af0Cc6D3bD243509F3c7cBaF4993456E9cd1653` |
| Morpho Blue (official code, our deployment) | `0x2e1c18d61803ced2015ee56858c41584dE94b2BC` |
| Market oracle (mock, for the replay) | `0x45fa522D318f599Fd5193566022Fec2C190ee082` |

All verified on Sourcify.

## Perpl

The first market studied was Perpl's BTC perpetual, read through Perpl's Rust SDK. Perpl's design (book, then a backstop buyer, then deleveraging at the bankruptcy price, with the mark clamped to the oracle) leaves almost no bad debt in an orderly fall. The app's Perpl tab shows how much open interest each fund can carry through a gap while liquidations are paused, with and without a cover layer. A Perpl cover vault ran on Monad testnet:

| Contract | Address |
| --- | --- |
| CoverVault | `0xcD8ba1eE2c958fed2Ef738040EDE0F06230d82D8` |
| MockBackstopAdapter | `0x66A7B7780f7DD61c253Aa1702f49E951d093D0d0` |
| MockUSD (tUSD) | `0x2cBc5292f1fE0500a90723dbd98a51F274C778c7` |

Its first payout (transaction `0x9d033418e9f67bc6faaadd095dcfc3aefc1cf48f83ce8c8c36e1a07fdffbbe82`) matched the engine's forecast exactly. Details in `watcher/reports/testnet-oi10x-gap18.json`.

## Layout

| Path | What it is |
| --- | --- |
| `lending/` | Stress test of every Morpho market on Monad, cover pricing, shortfall proofs and replay books |
| `contracts/` | Morpho cover vault and its replay on our own Morpho Blue; the Perpl cover vault (Foundry) |
| `research/` | Scripts and data behind `docs/RESEARCH.md`: failure rates, oracles, exit quotes |
| `fixtures/` | Dated Morpho and Perpl snapshots |
| `engine/` | Perpl risk engine and the Morpho snapshot script |
| `snapshot/` | Rust reader for Perpl through its SDK |
| `watcher/` | Keeper and scenario runner for the Perpl vault |
| `cre/` | Chainlink CRE workflow that claims the Morpho cover's losses on Monad testnet, unwritten ones included |
| `web/` | The app: a flood picture per market, the Perpl tab and a verify page |

## Run it

Needs Node 22, pnpm 9, Foundry and Rust 1.85 or newer.

```bash
pnpm install
pnpm --filter @spillway/lending test
pnpm --filter @spillway/lending run report fixtures/morpho/monad-2026-10-06.json --out lending-bundle.json
(cd contracts && forge build --force && forge test)
pnpm --filter @spillway/web data && pnpm --filter @spillway/web dev
```

Every modelling assumption lives in `lending/src/config.ts` or `engine/src/config.ts`, with its source.

## What is real and what is not

- Real: mainnet data, the engine, the contracts, and the payouts on testnet and on a local Morpho Blue.
- Replayed: Monad's lending markets have recorded no bad debt, so the loss event is staged on our own Morpho Blue with positions copied from a cited mainnet block.
- Not raised: no capital. Layer sizes and premiums are model outputs.

Started 2 October 2026.
