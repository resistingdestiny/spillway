# Lending: stress tests and cover for Monad's lending markets

Spillway prices the risk that a lending market's losses reach its depositors, publishes the test behind every price, and sells cover that pays automatically when the loss shows up on chain. This page is the shared design for that work. `ARCHITECTURE.md` covers the Perpl side.

## Where losses come from

In Morpho Blue a borrower is healthy while `collateral * oraclePrice * LLTV >= borrowed`. Once unhealthy, anyone may liquidate: they repay debt and seize collateral worth the repaid amount times the liquidation incentive factor

```
LIF = min(1.15, 1 / (1 - 0.3 * (1 - LLTV)))
```

(1.0168 at 94.5% LLTV, 1.0262 at 91.5%, 1.0438 at 86%, 1.0741 at 77%). If the collateral runs out before the debt is repaid, Morpho writes the rest off: `totalSupplyAssets` falls by the bad debt and every supplier of that market loses pro rata, which shows up as a fall in the market's supply share price. The `Liquidate` event records the amount as `badDebtAssets`.

For one position with debt `D` and collateral worth `V` at the oracle price:

| Situation | Loss to suppliers |
| --- | --- |
| Healthy | 0 |
| Unhealthy, liquidators act, `V / LIF >= D` | 0 (the borrower keeps the rest) |
| Unhealthy, liquidators act, `V / LIF < D` | `D - V / LIF`, realised at once |
| Unhealthy, nobody liquidates | `max(0, D - V)`, unrealised until someone does |

Liquidators act only when they can sell the seized collateral for more than they repaid, so when the slippage to sell it is below `1 - 1 / LIF`. That makes exit liquidity on Monad's exchanges part of the test.

## Scenarios

Every large loss in 2025 and 2026 came from collateral failing (Stream and Elixir, Resolv USR, Kelp rsETH), not from a market slide. So scenarios shock the collateral against the loan asset:

- **Depeg:** a collateral token falls by 1% to 100% against its loan asset, one token at a time, with the oracle following it.
- **Hidden loss:** the token's market price falls but its oracle does not (a fixed or exchange-rate oracle). No liquidation fires; the loss is unrealised until the oracle or a liquidator catches up.
- **Thin exit:** as a depeg, but liquidators act only up to the exit depth available within the incentive. Exit depth comes from quotes on Monad's exchanges (`RESEARCH.md` section 3). This is the headline scenario; liquidators always acting is the comparison.
- **Nobody liquidates:** as a depeg, with no liquidations. The thin exit at zero depth.

Most large Monad markets price collateral from an issuer or vault figure (`RESEARCH.md` section 2), so for them a shock means the issuer marks down, not the market price falling.

Every scenario reports, per market: liquidatable debt, bad debt realised, bad debt left unrealised, and the bad debt split across the market's suppliers (vaults by name).

## Run manifest

Every published run carries: the Monad block (or block range) of the inputs, the SHA-256 of the input file, the git commit of the engine, the config, and a one-line command that reproduces the outputs byte for byte. Inputs live in `fixtures/morpho/`.

## Cover

A policy covers one holder's supply in one whitelisted Morpho market.

- **Trigger:** the market's supply share price, `totalSupplyAssets / totalSupplyShares` read from Morpho after accruing interest. It only falls when bad debt is realised. Anyone can read it, and anyone can force realisation by liquidating, so no keeper or vote is needed.
- **Shortfall proof:** with thin exits, a loss can sit unrealised and the share price does not move. Anyone can instead name the market's short borrowers, and the contract sums `max(0, debt - collateral x price)` over them from Morpho's position data at the oracle price, with Morpho's rounding. `lending/src/shortfall.ts` computes the same figure off chain and the list to pass.
- **Payout:** `coveredShares * (sharePriceAtStart - sharePriceNow)`, less a deductible, capped by the policy limit and by the vault's remaining capital. `claim()` is permissionless and pays the policyholder.
- **Capital that cannot run:** withdrawals need notice longer than the claim window, so underwriters cannot leave between a loss and its claim.
- **Whitelist and dust:** only listed market ids and oracles, and a minimum loss before a claim pays.
- **Premium:** priced from the scenarios above times how often each kind of collateral has failed, stated openly.

## Testnet replay

Live markets on Monad have recorded no bad debt so far. The demo copies the largest positions of a real market from a cited mainnet block into a Morpho Blue deployment on Monad testnet, with a mock oracle we control. It then breaks the collateral, liquidates, and shows the cover paying depositors the amount the engine predicted. The app labels it as a replay. Morpho Blue has no deployment on Monad testnet, so the replay deploys the official contracts itself, pinned in `contracts/lib/morpho-blue`. `contracts/README.md` has the scripts and the input format.
