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
