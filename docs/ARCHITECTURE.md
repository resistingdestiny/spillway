# Architecture

Four parts pass one number between them: the shortfall of one market's insurance fund.

```
Perpl (Monad) --SDK + REST--> snapshot/ --JSON--> engine/ --timeline--> web/
                                                     |
                                                     +--forecast--> watcher/ <--events-- contracts/ (vault + adapter)
```

- `snapshot/` reads one market at one block: every open position, the full order book, the insurance fund and the liquidation split. Output is a JSON file in the schema below.
- `engine/` turns a snapshot into a loss curve. It drops the price, plays the cascade forward and records every event. It runs in Node and in the browser, and the same snapshot and seed always give the same result.
- `contracts/` holds the cover vault (one excess-of-loss layer), a mock backstop adapter that mirrors a perpetual's insurance fund on testnet, and a mock dollar token.
- `web/` draws the flood picture from the engine's event list and a clock, nothing else.

## Loss waterfall

Bad debt is the part of a liquidation loss that the trader's own margin does not cover. It is paid in this order:

1. The market's insurance fund, down to zero.
2. The Spillway layer, up to its remaining limit.
3. Winning traders on the other side, through auto-deleveraging.

Perpl's own docs describe two paths for bad debt. A liquidation that fills below the bankruptcy price leaves the perpetual short at settlement, and the insurance fund pays (`InsurancePaymentForSettlement`). A position that gaps through its bankruptcy price before it can be liquidated is deleveraged against profitable positions (`PositionDeleveraged`). The engine reports both, and the waterfall above is the order Spillway proposes for the exchange to adopt.

## Snapshot schema (`spillway.snapshot/1`)

All money is in dollars of the 6-decimal collateral token, as JSON numbers. Prices and sizes are decimal numbers already scaled by the market's price and lot decimals.

```jsonc
{
  "schema": "spillway.snapshot/1",
  "network": "mainnet",            // or "testnet"
  "chainId": 143,
  "exchange": "0x34B6...",
  "block": 55077246,
  "blockTimestamp": 1790970883,    // unix seconds
  "takenAt": "2026-10-02T19:00:00Z",
  "source": { "sdk": "perpl-sdk 0.2.0", "dexRevision": "...", "api": "https://app.perpl.xyz/api" },
  "market": {
    "perpId": 1,
    "symbol": "BTC",
    "name": "BTC Perp",
    "priceDecimals": 1,
    "lotDecimals": 5,
    "markPrice": 84196.6,
    "oraclePrice": 84172.8,
    "lastPrice": 84236.3,
    "maintenanceMarginFraction": 0.04,   // MMR = notional * this
    "initialMarginFraction": 0.0667,
    "takerFee": 0.00035,
    "makerFee": 0.0001,
    "longOpenInterest": 9.66267,          // in lots of the asset
    "shortOpenInterest": 9.66267,
    "insuranceFund": 178373.412064,
    "positionBalance": 273863.472150,
    "liquidationSplit": { "trader": 0.8, "insurance": 0.1, "protocol": 0.1 },
    "feeInsuranceShare": 0.15,            // share of fees routed to the insurance fund
    "fundingRate": 0.0
  },
  "positions": [
    {
      "accountId": 1234,
      "side": "long",                     // or "short"
      "size": 0.5,                        // asset units
      "entryPrice": 84000.1,
      "deposit": 4200.0,                  // collateral posted to this position
      "premiumPnl": -1.2,                 // funding owed, signed
      "deltaPnl": 98.3,
      "liquidationPrice": 79800.0,        // as computed by the SDK
      "bankruptcyPrice": 75602.5
    }
  ],
  "book": {
    "bids": [[84190.0, 0.25, 3]],         // [price, size, orders], best first
    "asks": [[84200.0, 0.10, 1]]
  }
}
```

## Engine outputs

Every run returns a timeline: an ordered list of events with a time in seconds, plus running totals. The renderer draws from the timeline only.

| Event | Meaning |
| --- | --- |
| `shock` | The outside price move, the ghost marker |
| `liquidation` | A ledge breaks: size, fill price, residual or bad debt |
| `fund_draw` | The insurance fund pays part of a loss |
| `layer_draw` | The Spillway layer pays part of a loss |
| `adl` | Winning traders absorb what is left |
| `settle` | The cascade has stopped; final price and totals |

Run kinds:

- **Stress**: one drop size, from 1% to 40%.
- **Replay**: a past crash's price path, as a relative move, mapped onto today's book.
- **Monte Carlo**: yearly chance of reaching each loss level, which sets the premium.

## Contracts

`CoverVault` holds one layer. Capital providers deposit the collateral token and receive shares. The exchange (the sponsor) funds a premium that streams to shareholders over a fixed term. When the adapter reports a shortfall, anyone can call `settle()`, which pays the adapter the lower of the shortfall, the remaining limit and the vault's principal. After the term ends, shareholders withdraw their share of what is left plus any unclaimed premium.

`MockBackstopAdapter` mirrors one perpetual's insurance fund on testnet. A scenario runner posts bad debt to it. The adapter pays from its fund first, records any shortfall, receives cover from the vault and books the rest as auto-deleveraging.

On Perpl itself the protocol can move its own balance into a perpetual's insurance fund (`xferProtocolToPerp`, event `TransferProtocolToPerp`). Whether a third party can do the same is an open question for the Perpl team, so the demo uses the mock adapter.
