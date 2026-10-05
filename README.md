# Spillway

A second line of defence for a perp exchange's insurance fund, funded by outside capital and priced by a model.

When a leveraged position is liquidated at a loss bigger than its margin, someone covers the gap. The exchange's insurance fund pays first. If the fund runs out, the exchange closes out winning traders (auto-deleveraging). Spillway adds one layer between the two: capital providers deposit into a vault and earn a premium, and if a cascade burns through the fund, the vault pays the next slice of loss up to a fixed limit.

Built for the Monad Metropolis hackathon on [Perpl](https://perpl.xyz).

## Layout

| Path | What it is |
| --- | --- |
| `snapshot/` | Rust tool that reads one Perpl market (positions, order book, insurance fund) through the Perpl SDK |
| `engine/` | Risk engine: liquidation maths, cascade simulation, stress, replay and Monte Carlo runs |
| `contracts/` | Cover vault, mock backstop adapter and trigger (Foundry) |
| `web/` | The flood picture: stress slider, replay and deposit flow |

## On Monad testnet

| Contract | Address |
| --- | --- |
| CoverVault | `0xcD8ba1eE2c958fed2Ef738040EDE0F06230d82D8` |
| MockBackstopAdapter | `0x66A7B7780f7DD61c253Aa1702f49E951d093D0d0` |
| MockUSD (tUSD) | `0x2cBc5292f1fE0500a90723dbd98a51F274C778c7` |

All three are verified on Sourcify. The first payout, from a simulated 18% gap at 10x today's BTC open interest, is transaction `0x9d033418e9f67bc6faaadd095dcfc3aefc1cf48f83ce8c8c36e1a07fdffbbe82`: the fund paid $178,389.91 and Spillway paid $147,378.49, exactly as the engine forecast. Details in `watcher/reports/testnet-oi10x-gap18.json`.

## Run it

Needs Node 22, pnpm 9, Foundry and Rust 1.85 or newer.

```bash
pnpm install
pnpm -r test                                   # engine tests
(cd contracts && forge test)                   # vault tests
pnpm --filter @spillway/engine cli stress fixtures/snapshots/btc-mainnet.json --move 0.1
pnpm --filter @spillway/web data               # bundle the engine output for the app
pnpm --filter @spillway/web dev
```

Every modelling assumption lives in `engine/src/config.ts`, with a comment saying where it comes from.

## Status

Work in progress. Started 2 October 2026.
