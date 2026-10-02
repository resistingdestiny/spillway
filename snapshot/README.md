# spillway-snapshot

Reads one Perpl market at one block and writes a `spillway.snapshot/1` JSON file: every open position, the full order book, the insurance fund and the liquidation split. The schema is in [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md). The engine replays liquidation cascades on top of it.

It is built on [Perpl's Rust SDK](https://github.com/PerplFoundation/dex-sdk) (`perpl-sdk`), pinned to a git revision in `Cargo.toml`.

## Run

Needs Rust 1.97 or later (`rust-toolchain.toml` pins it).

```sh
cd snapshot
cargo run -- --network mainnet --market BTC --out ../fixtures/snapshots/btc-mainnet.json
cargo run -- --network testnet --market BTC --out ../fixtures/snapshots/btc-testnet.json
cargo run -- --network mainnet --market 20 > eth.json
```

A run takes a few seconds and is bound by the network, so a debug build is fine.

| Flag | Meaning |
| --- | --- |
| `--network mainnet\|testnet` | Perpl deployment (chain 143 or 10143). Default mainnet. |
| `--market BTC\|<perpId>` | Symbol or perpetual id. Mainnet: BTC=1, MON=10, ETH=20. Testnet: BTC=16, MON=64. |
| `--block N` | Block to read at. Default: the latest safe block. The public RPC served state 200,000 blocks back (about a day) but not 2,000,000. |
| `--rpc URL` | RPC endpoint. Default: the public Monad RPC. |
| `--api URL` | Perpl REST base. Default: `https://app.perpl.xyz/api` or `https://testnet.perpl.xyz/api`. |
| `--out FILE` | Output file. Default: stdout. |
| `--rps N` | RPC requests per second (default 15). |
| `--batch N` | Positions and orders per multicall (SDK default 1000). |

JSON goes to the file or stdout. A short check of the data goes to stderr.

## What it reads, and how

Everything is read at one pinned block number, so the pieces are consistent with each other.

1. **Market id.** `GET {api}/v1/pub/context` (public, no auth) maps the symbol to a perpetual id. Its decimals and margins are cross-checked against the chain. If the call fails, the tool falls back to `perpl_sdk::state::listed_perpetuals` and each perpetual's on-chain symbol, and says so in `source.notes`.
2. **Market, book and positions.** One SDK snapshot:
   ```rust
   SnapshotBuilder::new(&Chain::mainnet(), provider)
       .with_perpetuals(vec![perp_id])
       .with_all_positions()
       .at_block(BlockId::number(block))
       .build()
   ```
   From the returned `Exchange`:
   - `perpetuals()[id]`: mark, oracle and last price, `maintenance_margin()` and `initial_margin()`, `taker_fee()`, `maker_fee()`, `funding_rate()`, price and lot converters.
   - `accounts()[..].positions()[id]`: side, size, entry price, deposit, premium and delta PnL, and the SDK's own `liquidation_price()` and `bankruptcy_price()`.
   - `l3_book()`: every resting order. Live orders are summed per price into `[price, size, orders]` levels, bids highest first, asks lowest first. Orders past their expiry block are left out, as the exchange will not fill them. The result is checked against the SDK's cached L2 levels.
3. **Insurance fund and liquidation split.** The SDK's `Perpetual` has no insurance fund, so these come from the SDK's generated binding `perpl_sdk::abi::dex::Exchange`, in one multicall at the same block: `getPerpetualInfoV2` (insurance and position balance, long and short open interest), `getLiquidationInfo` (trader, insurance and protocol shares of a liquidation, per 100,000) and `getInsuranceProtocolSplit` (share of fees to the insurance fund).

The provider throttles requests and backs off on rate limits (alloy `ThrottleLayer` and `RetryBackoffLayer`). The SDK reads positions and orders in multicall batches that fit Monad's `eth_call` gas cap, and halves a batch that fails.

## Units

- Money is in dollars of the 6-decimal collateral token (AUSD).
- Prices and sizes are decimals already scaled by the market's price and lot decimals.
- `maintenanceMarginFraction` and `initialMarginFraction` are fractions of notional. The SDK stores them as leverage (25 for BTC), so the fraction is 1 / that (0.04).
- `takerFee` and `makerFee` are the base tier rates as fractions of notional.
- `fundingRate` is the SDK's `funding_rate()`: the rate of the last funding event, as a fraction per funding interval.
- `deltaPnl` and `premiumPnl` come from the contract's position view at the block. `deltaPnl` matches (mark - entry) * size.

## Checks

Every run prints to stderr: the block, positions per side, the sum of position sizes per side against the contract's open interest (summed as exact decimals), the insurance fund, best bid and ask, level counts, bid and ask depth within 1%, 5% and 10% of mid, the leverage range, and how many positions sit past their liquidation price at the mark. Anything odd also lands in `source.notes` in the JSON.

Sample outputs live in `../fixtures/snapshots/`.

Example stderr from the mainnet fixture run:

```
mainnet BTC (perp 1) at block 109992422 (1790973812), contract v1.1.7.5
mark 84263.3 (age 39s), oracle 84248.8 (age 26s), last 84298
insurance fund $178387.85, position balance $272124.21, liquidation split trader/insurance/protocol 0.8/0.1/0.1, fee share to insurance 0.15
positions: 224
  long   151 positions, sum of sizes 9.58400 vs open interest 9.58400: OK
  short   73 positions, sum of sizes 9.58400 vs open interest 9.58400: OK
book: 81 bid levels, 148 ask levels, 2 expired orders left out, 0 L2 mismatches
  best bid 84298 / best ask 84307.6, spread 1.14 bps, mid 84302.8
  depth within  1% of mid: bids $184022, asks $112358
```
