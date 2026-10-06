# indexer

Rebuilds every Morpho Blue market and position on Monad at any block from Morpho's own events, and writes it as a `spillway.morpho-snapshot/1` file that `lending/` loads like the API snapshot. Every number the stress test publishes can then be recomputed from the chain alone.

## What it does

1. **Fetch.** Every log of Morpho Blue on Monad (`0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee`) from its deployment block, 31,907,457, to the requested block. Only the events the replay reads are asked for: CreateMarket, SetFee, SetFeeRecipient, AccrueInterest, Supply, Withdraw, Borrow, Repay, SupplyCollateral, WithdrawCollateral and Liquidate. Logs are stored in gzipped ranges of 5M blocks under `cache/`, so a later block fetches only what is new.
2. **Replay.** `src/replay.ts` applies each event to Morpho's storage as `Morpho.sol` does: market totals, and each position's supply shares, borrow shares and collateral. Each event carries the assets and shares Morpho settled on, so state moves by exactly those. AccrueInterest adds the interest to both sides and credits fee shares to the fee recipient. Liquidate repays, seizes and, when the borrower's collateral reaches zero, writes the remaining debt off against supply.
3. **Check every step.** Each event is also recomputed from the replayed totals with Morpho's integer math (`src/math.ts`, line for line from `MathLib` and `SharesMathLib`): shares from assets with Morpho's rounding, interest from the previous rate and the seconds elapsed (`wTaylorCompounded`), fee shares, repaid assets and bad debt. A disagreement means the replay has left the chain, and is recorded. A subtraction below zero (a missing log) stops the replay.
4. **Snapshot.** `src/snapshot.ts` writes the book with token decimals, symbols and oracle prices read by `eth_call` at the block. Position assets are converted from shares as Morpho does (supply down, borrow up) at the stored totals. Fields that are not on chain (USD prices, Morpho's listing, oracle type names, the Vault V2s supplying a market) are copied from a reference API snapshot given with `--labels`, and named in `source.labels`.
5. **Reconcile.** `src/reconcile.ts` compares the replay with an API snapshot at both ends of the block window its state lies in. `src/chain.ts` reads Morpho's own `market(id)` and `position(id, user)` at the same blocks for every market and open position.

## How Envio is used

The logs come from [Envio HyperSync](https://docs.envio.dev/docs/HyperSync/overview), which serves Monad mainnet (chain 143) at `https://monad.hypersync.xyz`. `src/hypersync.ts` sends one query through `@envio-dev/hypersync-client`: the Morpho address, the eleven topic0 values, and the log fields the replay needs, with each block's timestamp joined in. HyperSync answers as much of the range as it can per request and returns `nextBlock`, so the client pages to the end block. There is no indexer to run and no database: the whole history is a few requests.

HyperSync needs an API token for every query (HTTP 401 without one). A free token comes from `https://app.envio.dev/api-tokens` after signing in. Set it as `ENVIO_API_TOKEN` and the indexer uses HyperSync. Without a token it reads the same logs from Monad's public RPC (`rpc1.monad.xyz`, which answers `eth_getLogs` over any range up to 10,000 logs). Both sources produce the same raw log records (`RawLog` in `src/events.ts`), so the replay never knows which one ran. The stored ranges name their source in their header.

The published fixtures below were built from the public RPC: no HyperSync token was available. The HyperSync path typechecks against the client's own types and follows its documented query shape, but it has not yet run against the live service.

HyperIndex, Envio's full indexing framework, was not used. It runs a Postgres database and a GraphQL server in Docker, while this job is one replay to one block.

## Run it

```bash
pnpm install
# The book at a block, as a snapshot lending/ loads
pnpm --filter @spillway/indexer run snapshot --block 111058632 --out fixtures/morpho/monad-2026-10-06.indexed.json \
  --labels fixtures/morpho/monad-2026-10-06.json
# The stress test on it
pnpm --filter @spillway/lending run report fixtures/morpho/monad-2026-10-06.indexed.json \
  --adapters fixtures/morpho/monad-2026-10-06.adapters.json --out bundle.json
# Reconcile with the API snapshot, at both of its blocks
pnpm --filter @spillway/indexer run reconcile fixtures/morpho/monad-2026-10-06.json
# Tests: recorded fixtures only, no network
pnpm --filter @spillway/indexer test
```

Add `--source hypersync` or `--source rpc` to force a source. The first run fetches about 670,000 logs; over the public RPC that takes about a minute.

## Reconciliation with the 6 October 2026 snapshot

`fixtures/morpho/monad-2026-10-06.json` was pulled from Morpho's API between blocks 111,058,609 and 111,058,632. The replay was run to both blocks. Morpho emitted no event in between, so the replayed book is the same at both ends. Full output: `reconciliation/monad-2026-10-06.json`.

| Check | Result, at both blocks |
| --- | --- |
| Events replayed | 672,131 |
| Event recomputations from replayed state | 964,389 agree, 0 disagree |
| Morpho storage, 130 markets | every total and share equal |
| Morpho storage, 1,109 open positions | every supply share, borrow share and collateral equal |
| API, 1,109 positions | every supply share, borrow share and collateral equal, none missing on either side |
| API, 130 markets | every supply share, borrow share and collateral total equal |
| API, market supply and borrow assets | 47 equal; 83 higher by the IRM's interest since the last update |

The differences and their causes:

- **Assets: the API accrues interest Morpho has not stored.** Morpho stores totals as of each market's last update. The API reports them with interest accrued, virtually, to the moment it read the market (`state.timestamp`, between 1791295499 and 1791295919). In all 83 markets the gap is equal on the supply and the borrow side. Recomputed with the market's own IRM (`borrowRateView` at the block) over the API's elapsed seconds, it matches to the wei in 53 markets, within 0.01% in 21 or 22 more, and within 0.036% in the rest. The remainder exists because the IRM's mean rate is read at the block, not at the API's earlier moment; it grows from the first block to the second, as that explanation predicts.
- **lastUpdate of four idle markets.** Anyone may call `Morpho.accrueInterest()`. In a market with no IRM it moves `lastUpdate` and emits nothing, so no log records it. Such a market never accrues interest, so no amount depends on it. The replay moves `lastUpdate` on every call that accrues; these four were moved by direct calls.
- **Six dust borrowers.** Six positions hold 1 to 606,690 borrow shares. The API rounds their debt down to 0 assets. Morpho's own `expectedBorrowAssets` rounds up, to 1 wei, so the indexed book counts 453 borrowers to the API's 447.
- **Oracle prices.** The snapshot reads each oracle at the block. 26 of 130 markets price from a market feed that moved by up to 0.087% between the API's reads and the block.

The stress test (`lending/`) run on the indexed book gives the same markets and positions as on the API book, and the same vault table at the precision it prints, with dollar figures that differ by the interest and the price moves above. For example, wstETH/WETH debt is $35,417,668 against the API book's $35,417,698, and its 10% markdown loss is $683,106 against $683,128.

Monad has not yet seen a Liquidate with bad debt, nor a market with a fee: no SetFee or SetFeeRecipient event exists. Those paths of the replay are tested on hand-built events with Morpho's own formulas (`test/accounting.test.ts`).

## Tests

- `test/replay.test.ts`: a recorded market (`0x67c3a8f2...`, 735 logs with every kind of event including a liquidation) replays to exactly Morpho's storage at block 111,058,632, read by `eth_call` and stored in the fixture. Every event recomputes, and dropping one log is caught.
- `test/accounting.test.ts`: bad debt written off against suppliers, interest, fee shares, and forged amounts flagged.
- `test/snapshot.test.ts`: the snapshot loads in `lending/`.

`scripts/record-fixture.ts` records a market fixture from the local log store.

## Files

| Path | What it is |
| --- | --- |
| `src/config.ts` | Every constant, with its source |
| `src/events.ts` | Event signatures and the decoder |
| `src/math.ts` | Morpho Blue's integer math |
| `src/replay.ts` | The replay and its checks |
| `src/hypersync.ts`, `src/rpc.ts` | The two log sources |
| `src/logs.ts`, `src/run.ts` | The log store and the replay driver |
| `src/chain.ts` | Reads at the snapshot block: tokens, oracle prices, IRM rates, Morpho's storage |
| `src/snapshot.ts`, `src/reconcile.ts` | Output and comparison |
