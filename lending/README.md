# @spillway/lending

A stress test of every Morpho Blue market on Monad, one position at a time, as `docs/LENDING.md` sets out. It reads a committed snapshot of Morpho's public API, breaks one collateral token at a time, and works out what each borrower's failure would cost the market's suppliers and, through them, each Morpho vault's depositors. The same numbers set the size and the price of cover.

## What it does

1. **Loads** `fixtures/morpho/<date>.json` (written by `engine/scripts/snapshot-morpho.ts`) into typed markets and positions. Every raw amount is read as an exact integer, then scaled by its token's decimals. The oracle price is Morpho's `price()`: loan base units per collateral base unit times 1e36, so whole loan tokens per whole collateral token is `price / 10^(36 + loanDecimals - collateralDecimals)`.
2. **Checks fidelity** before building on the data (`src/fidelity.ts`, `test/fidelity.test.ts`). It recomputes every borrower's health factor, `collateral * price * LLTV / debt`, and compares it with the API's. All 447 borrowers match within 0.1%, and 254 match to rounding. Where they differ, every borrower in the market differs by the same ratio, so the gap is the oracle read the API used for that field, not the formula. Each market's positions add up to its supply, borrow and collateral totals within 1%.
3. **Names vaults.** A Morpho Vault V2 supplies through an adapter contract, so no supplier address on a market equals a vault address in the API's `supplyingVaultV2s`. `scripts/resolve-adapters.ts` calls `parentVault()` on all 202 supplier addresses at the snapshot's block and commits the answer as `<snapshot>.adapters.json`. That names 30 vaults holding 84% of supply by value. The report reads that file and never touches the network.
4. **Models each position** (`src/model.ts`). The liquidation incentive is `LIF = min(1.15, 1 / (1 - 0.3 * (1 - LLTV)))`. A position is healthy; or liquidated with no loss when its collateral covers the debt times the LIF; or liquidated with bad debt `debt - value / LIF`, written off at once; or not liquidated, with `max(0, debt - value)` left unrealised.
5. **Measures exit depth** (`src/exit.ts`). A liquidator who sells the seized collateral at a loss of more than `1 - 1/LIF` against the oracle is out of pocket, so stops. From the best quotes found on Monad at $1k, $100k, $1M and $10M (`docs/RESEARCH.md` section 3), the depth for each market is the largest sale whose loss stays inside its own `1 - 1/LIF`, linear in size between the quoted sizes. No route is zero. 13 tokens were quoted; the rest have no measured depth and no limit.
6. **Runs four scenarios**, one collateral token at a time across every market that takes it (`src/scenarios.ts`):
   - **thin exit, the headline:** the token falls and the oracle follows in one jump, but liquidators sell only up to the exit depth. They clear the most unhealthy positions first, and every market that takes the token sells into the same pools.
   - **liquidators always act, the comparison:** the same jump with unlimited depth.
   - **hidden loss:** the token falls but the oracle holds. Nothing new is liquidated and the loss stays unrealised.
   - **nobody liquidates:** the jump with no liquidations at all. The thin exit equals it at zero depth.
7. **Says what a shock means** for the eight largest markets, whose oracles `docs/RESEARCH.md` section 2 read on chain: exchange rate, vault share price, issuer NAV or Pendle PT TWAP. Six cannot see the collateral's market price, so their curves mean "the issuer marks down by X". The two PT markets follow the PT's market price against its underlying, so theirs mean "the market price falls by X".
8. **Attributes** each market's loss to its suppliers pro rata by supply shares, the way Morpho writes bad debt off, and sums it by vault (`src/attribution.ts`).
9. **Proves shortfalls** (`src/shortfall.ts`). For a market, an oracle price and a list of borrowers, the shortfall is the sum of `max(0, debt - collateral x price)`, in loan-token base units, with debt rounded up from borrow shares and collateral value rounded down, as Morpho's health check does. The witness for a markdown is every borrower who is short, in ascending order. The cover contract can compute the same figure on chain from Morpho's position data, so a loss that liquidators leave unrealised can still be shown.
10. **Reports** (`src/report.ts`): a stress curve per market; a probable maximum loss (PML) table that ranks collateral tokens by the loss their failure would put on depositors across all markets; the loss to each vault's depositors for each token and fall; and the cover limit that keeps a vault's depositors whole when any one token falls by X.
11. **Prices cover** for each vault (`src/pricing.ts`). Each class has an annual failure probability with its 90% range and the falls seen in its incidents (`docs/RESEARCH.md` section 1). A PT takes its underlying's class plus a PT-specific 1.33%. The expected yearly loss to depositors is the sum over the tokens a vault lends against of `p(class) x` the mean thin exit loss over the class's falls. The limit keeps depositors whole at each class's 90th percentile fall, and `rate = expected loss to the cover / limit x (1 + risk load) + capital charge`, as in `engine/src/pricing.ts`. Bridged majors, Monad's own coin, tokenised gold and test tokens are not researched and keep placeholder rates; a vault that lends against one lists them in `placeholderTokens`.

Every assumption lives in `src/config.ts` with its source.

## Rerun a published number

From the repository root:

```
pnpm install
pnpm --filter @spillway/lending run report fixtures/morpho/monad-2026-10-06.json --out lending-bundle.json
```

The bundle (`spillway.lending-bundle/2`) names its data sources in `config.sources`. Its `manifest` holds the SHA-256 of the snapshot and adapters files, the Monad block range (111058609 to 111058632), the git commit, the SHA-256 of the config, and this command. At the same commit two runs give the same bytes (`test/report.test.ts` checks it). At another commit only `manifest.commit` changes, unless the code or fixtures changed. To find a number, for example the top of the PML table:

```
jq '.pml[0]' lending-bundle.json
jq '.markets[] | select(.collateral.symbol == "wstETH" and .loan.symbol == "WETH") | .thin.unrealisedUsd[25]' lending-bundle.json
jq '.shortfalls[] | select(.pair == "wstETH/WETH") | .proofs[2]' lending-bundle.json
```

`.shocks` is the grid the curves are on, so index 25 is a 25% fall. `.thin` is the headline, `.depeg` is liquidators always acting. To refresh the vault names for a new snapshot, run `tsx scripts/resolve-adapters.ts <snapshot.json>` inside `lending/`. Tests: `pnpm --filter @spillway/lending test`.

## Results on the 6 October 2026 snapshot

130 markets, 92 with borrowers. 447 borrowers owe $131.8M against $154.8M supplied, at the API's USD prices. Monad's markets have recorded no bad debt so far. Each result below states what would have to happen for depositors to lose money. A "jump" is the oracle moving from today's price to the shocked price in one update. A slow slide with liquidators at work leaves no bad debt in Morpho Blue, because at the liquidation point `LLTV x LIF < 1` and the collateral still covers the debt plus the incentive.

Headline figures are the thin exit: liquidators sell only what Monad's exchanges take within the incentive. "Always act" is the same jump with liquidators clearing everything. Sources: Morpho's API for the book, Monad's RPC for vault adapters and oracles, DefiLlama for failure rates and incident falls, and KyberSwap, Kuru, Monorail, LI.FI and Pendle's API for exit quotes (`config.sources` in the bundle, `docs/RESEARCH.md` for the method).

### The five largest markets

| Market | LLTV | Borrowed | Its oracle moves when | Exit depth within the incentive | Suppliers lose nothing unless | A 25% jump would cost suppliers | Always act |
| --- | --- | --- | --- | --- | --- | --- | --- |
| wstETH / WETH | 94.5% | $35.4M | the stETH per wstETH rate is marked down | $6,146 | the rate is marked down 6% or more | $5.91M, all unrealised, $5.76M of it to Steakhouse Prime ETH | $6.39M |
| aHYPER / USDC | 77% | $34.4M | the vault reports a lower share price | 0 | the share price is marked down 24% or more | $0.03M; a 50% markdown, $9.53M | $0.59M |
| PT-USDat-14JAN2027 / USDC | 91.5% | $21.4M | the PT's market price falls against USDat (15 minute TWAP) | $1.16M | the PT falls 7% or more | $2.71M, $2.30M of it to Hyperithm USDC Apex | $3.11M |
| earnAUSD / USDC | 91.5% | $7.3M | the vault manager reports a lower share price | $2,292 | the share price is marked down 11% or more | $0.92M, $0.91M of it to August USDC V2 | $1.09M |
| strUSD / AUSD | 86% | $6.1M | the issuer's exchange rate is marked down | 0 (no route) | the rate is marked down 15% or more | $0.56M, $0.46M of it to SharpByte AUSD Tori Ecosystem | $0.77M |

Six of the eight markets whose oracles were read, $92.5M of the $117.5M they lend, price collateral from an issuer or vault figure. A fall in the collateral's market price does not reach those oracles. Their losses arrive when the issuer marks down, in one step, so the jump is the right model for them.

On Monad, liquidators could clear almost none of these markets inside one transaction. At a 25% jump, $10.8M of the $11.8M the thin exit would cost suppliers across all markets stays unrealised. Morpho has not written it off, so the supply share price does not fall and a cover triggered by the share price would not pay. Liquidating with fewer of them also costs suppliers less in total, because a liquidation that runs out of collateral pays the incentive out of their pockets.

The PT-USDat-14JAN2027 oracle hardcodes USDat = USDC. If USDat itself fails, the oracle does not move and the loss is hidden: a 25% fall leaves $2.68M unrealised.

### Provable shortfall

A loss that stays unrealised can still be proved. For a market, the shortfall at an oracle price is the sum over borrowers of `max(0, debt - collateral x price)`, read from Morpho's own position data. The bundle lists, at every report markdown, the shortfall and the borrowers to name to prove it:

| Market | Markdown | Shortfall | Borrowers to name |
| --- | --- | --- | --- |
| wstETH / WETH | 10% | $0.68M | 7 |
| wstETH / WETH | 25% | $5.91M | 16 |
| aHYPER / USDC | 50% | $9.53M | 42 |
| PT-USDat-14JAN2027 / USDC | 25% | $2.68M | 44 |

Today the shortfall in markets with a USD price is under one cent, from one dust position in a wsrUSD market.

### Collateral tokens by probable maximum loss

The PML is the loss to depositors, across every market, if the token became worthless. The smaller falls show how fast the loss builds. Each class's annual failure rate is in the cover prices below.

| Rank | Token | Class | Markets | PML | First loss at a jump of | 10% jump | 25% jump | 50% jump | 25% jump, always act | 25% fall, oracle holds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | wstETH | LST and LRT | 6 | $35.4M | 6% | $0.68M | $5.91M | $15.7M | $6.39M | $5.91M |
| 2 | aHYPER | managed strategy | 2 | $34.4M | 24% | 0 | $0.03M | $9.53M | $0.59M | $0.03M |
| 3 | PT-USDat-14JAN2027 | synthetic dollar, PT | 1 | $21.4M | 7% | $0.02M | $2.71M | $8.51M | $3.11M | $2.68M |
| 4 | earnAUSD | managed strategy | 2 | $7.3M | 11% | 0 | $0.92M | $3.05M | $1.09M | $0.92M |
| 5 | strUSD | synthetic dollar | 3 | $6.1M | 15% | 0 | $0.56M | $2.19M | $0.77M | $0.56M |

### The largest single positions

| Borrower | Market | Debt | Health factor | Liquidatable after a fall of | Leaves bad debt after a jump of |
| --- | --- | --- | --- | --- | --- |
| `0xa024063b630d554078bbf985718b22f3c6870ee0` | wstETH / WETH | $18.5M | 1.031 | 3.0% | 6.8% |
| `0x357d2614095e05ce2aaaeeec72d52f2b29ff7384` | aHYPER / USDC | $17.1M | 1.089 | 8.1% | 24.0% |
| `0x9ca1d6e730eb9fbfd45c9ff5f0ac4e3d172d8f4d` | wstETH / WETH | $7.4M | 1.145 | 12.6% | 16.1% |
| `0x42b901fbad7d571560949eca38a6d7b477d9fe51` | earnAUSD / USDC | $7.3M | 1.066 | 6.2% | 11.9% |
| `0x46e449074b7a2287048e8b770cf866ed6afd1bd1` | PT-USDat-14JAN2027 / USDC | $6.2M | 1.076 | 7.1% | 12.8% |

For the largest position to leave bad debt, the stETH per wstETH rate behind the oracle would have to be marked down more than 6.8% in one update. If liquidators always acted, a slower fall would let them close it from 3.0% on with no loss to suppliers. On Monad they could sell about $6,000 of wstETH within the incentive, so they would need their own WETH and would have to carry the $20.2M of wstETH it holds.

### Cover limits

The cover that keeps a vault's depositors whole if any one collateral token falls by the given amount in one jump, in the thin exit:

| Vault | Supplied to Morpho | 10% | 25% | 50% |
| --- | --- | --- | --- | --- |
| Hyperithm USDC Apex | $50.5M | $0.02M (PT-USDat-14JAN2027) | $2.30M (PT-USDat-14JAN2027) | $7.21M (PT-USDat-14JAN2027) |
| Steakhouse Prime ETH | $38.7M | $0.67M (wstETH) | $5.76M (wstETH) | $15.4M (wstETH) |
| August USDC V2 | $7.8M | 0 | $0.91M (earnAUSD) | $3.00M (earnAUSD) |
| Hyperithm cbBTC Apex | $7.7M | 0 | $0.02M (aHyperBTC) | $1.19M (mHyperBTC) |
| Y10k AUSD Vault | $5.6M | 0 | under $0.01M (syzUSD) | $0.92M (mROX) |

### Cover prices

Failure rates by class, from `docs/RESEARCH.md` section 1: synthetic dollars 10.3% a year (4.5% to 20.4%), managed and delta-neutral strategies 19.9% (7.8% to 41.8%), LSTs and LRTs 1.6% (0.3% to 4.9%), RWA and credit 5.2% (1.4% to 13.4%), wrapped BTC 5.1% (0.9% to 16.0%). The limit keeps a vault whole when its worst token falls by its class's 90th percentile fall: 99.7% for managed strategies and synthetic dollars, 20.1% for LSTs (rsETH), 48.2% for RWA (USDR).

| Vault | Supplied | Limit | Expected yearly loss to depositors (90% range) | Rate on the limit (top of range) | Premium as a share of supply |
| --- | --- | --- | --- | --- | --- |
| Hyperithm USDC Apex | $50.5M | $20.3M (aHYPER) | $5.62M ($2.20M to $11.4M) | 59.3% (116%) | 23.8% |
| Steakhouse Prime ETH | $38.7M | $3.87M (wstETH) | $0.06M ($0.01M to $0.19M) | 7.1% (13.7%) | 0.71% |
| August USDC V2 | $7.8M | $7.15M (earnAUSD) | $1.32M ($0.52M to $2.77M) | 40.8% (81.3%) | 37.4% |
| Hyperithm cbBTC Apex | $7.7M | $3.61M (mHyperBTC) | $1.22M ($0.48M to $2.57M) | 71.8% (147%) | 33.5% |
| Y10k AUSD Vault | $5.6M | $5.02M (mROX) | $0.91M ($0.36M to $1.92M) | 40.4% (80.5%) | 36.5% |

For Steakhouse Prime ETH's cover to pay its whole limit, the stETH per wstETH rate would have to be marked down by 20% in one update, as rsETH fell in April 2026. For Hyperithm USDC Apex's, aHYPER's share price would have to be marked down by 99.7%, as the worst managed dollars fell. The history says managed strategies fail often and lose almost everything when they do, so cover on vaults that lend against them costs 40% to 72% of the limit a year. The Hyperithm USDC Apex price also lends against WMON and WETH, which keep placeholder rates.

## Limits of the model

- One token fails at a time. Tokens from one issuer (aHYPER, mHYPER, aHyperBTC, mHyperBTC) or one underlying (the PT-AUSD markets) could fail together.
- The fall is a single jump at the snapshot. There is no price path, no interest accrual and no borrower adding collateral.
- Exit depth comes from quotes taken on one afternoon, 6 October 2026, for 13 tokens. Other tokens have no limit. A token's quotes into one loan asset stand for every market that takes it. Markets share the depth by total size sold, not by the marginal price of each sale.
- "No route" means no public API returned a quote. Liquidators could still redeem with the issuer or bridge out, outside one atomic transaction. The thin exit leaves that loss unrealised until they do.
- Three classes rest on one measured fall each (rsETH, USDR, uniBTC), so their 90th percentile is that one fall.
- Token classes marked "Assumption" or "Backing not confirmed" in `src/config.ts` are our reading of what the token is. A dollar token of unconfirmed backing takes the broad synthetic dollar class.
- Failure rates are pooled across chains and issuers since 2022. The managed strategy rate rests on 5 failures in 25.2 token-years.
- WETH, SOL, WMON, XAUt0 and test tokens keep placeholder failure rates.
- A vault that deposits into another vault is charged at the vault that holds the market position. The loss is not traced on to the depositing vault.
- 16% of supply by value is held by addresses that are not a Vault V2 adapter. Their losses are reported as other suppliers.
