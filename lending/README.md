# @spillway/lending

A stress test of every Morpho Blue market on Monad, one position at a time, as `docs/LENDING.md` sets out. It reads a committed snapshot of Morpho's public API, breaks one collateral token at a time, and works out what each borrower's failure would cost the market's suppliers and, through them, each Morpho vault's depositors. The same numbers set the size and the price of cover.

## What it does

1. **Loads** `fixtures/morpho/<date>.json` (written by `engine/scripts/snapshot-morpho.ts`) into typed markets and positions. Every raw amount is read as an exact integer, then scaled by its token's decimals. The oracle price is Morpho's `price()`: loan base units per collateral base unit times 1e36, so whole loan tokens per whole collateral token is `price / 10^(36 + loanDecimals - collateralDecimals)`.
2. **Checks fidelity** before building on the data (`src/fidelity.ts`, `test/fidelity.test.ts`). It recomputes every borrower's health factor, `collateral * price * LLTV / debt`, and compares it with the API's. All 447 borrowers match within 0.1%, and 254 match to rounding. Where they differ, every borrower in the market differs by the same ratio, so the gap is the oracle read the API used for that field, not the formula. Each market's positions add up to its supply, borrow and collateral totals within 1%.
3. **Names vaults.** A Morpho Vault V2 supplies through an adapter contract, so no supplier address on a market equals a vault address in the API's `supplyingVaultV2s`. `scripts/resolve-adapters.ts` calls `parentVault()` on all 202 supplier addresses at the snapshot's block and commits the answer as `<snapshot>.adapters.json`. That names 30 vaults holding 84% of supply by value. The report reads that file and never touches the network.
4. **Models each position** (`src/model.ts`). The liquidation incentive is `LIF = min(1.15, 1 / (1 - 0.3 * (1 - LLTV)))`. A position is healthy; or liquidated with no loss when its collateral covers the debt times the LIF; or liquidated with bad debt `debt - value / LIF`, written off at once; or not liquidated, with `max(0, debt - value)` left unrealised.
5. **Runs three scenarios**, one collateral token at a time across every market that takes it (`src/scenarios.ts`):
   - **depeg:** the token falls 0% to 100% against its loan asset and the oracle follows in one jump. Liquidators always act.
   - **hidden loss:** the token falls but the oracle holds. Nothing new is liquidated and the loss stays unrealised.
   - **thin exit:** as the depeg, but liquidators only act up to a dollar exit depth per token. With no depth set, it is the depeg.
6. **Attributes** each market's loss to its suppliers pro rata by supply shares, the way Morpho writes bad debt off, and sums it by vault (`src/attribution.ts`).
7. **Reports** (`src/report.ts`): a stress curve per market; a probable maximum loss (PML) table that ranks collateral tokens by the loss their failure would put on depositors across all markets; the loss to each vault's depositors for each token and fall; and the cover limit that keeps a vault's depositors whole when any one token falls by X.
8. **Prices cover** for each vault (`src/pricing.ts`): expected yearly loss from a failure probability and severity per collateral class, then `rate = expected loss rate x (1 + risk load) + capital charge`, as in `engine/src/pricing.ts`. **The failure table in `src/config.ts` is a placeholder.** It makes the formula run and is not an estimate. Every price in the bundle carries `placeholder: true` until research replaces it.

Every assumption lives in `src/config.ts` with its source.

## Rerun a published number

From the repository root:

```
pnpm install
pnpm --filter @spillway/lending run report fixtures/morpho/monad-2026-10-06.json --out lending-bundle.json
```

The bundle's `manifest` holds the SHA-256 of the snapshot and adapters files, the Monad block range (111058609 to 111058632), the git commit, the SHA-256 of the config, and this command. At the same commit two runs give the same bytes (`test/report.test.ts` checks it). At another commit only `manifest.commit` changes, unless the code or fixtures changed. To find a number, for example the top of the PML table:

```
jq '.pml[0]' lending-bundle.json
jq '.markets[] | select(.collateral.symbol == "wstETH" and .loan.symbol == "WETH") | .depeg.realisedUsd[10]' lending-bundle.json
```

`.shocks` is the grid the curves are on, so index 10 is a 10% fall. To refresh the vault names for a new snapshot, run `tsx scripts/resolve-adapters.ts <snapshot.json>` inside `lending/`. Tests: `pnpm --filter @spillway/lending test`.

## Results on the 6 October 2026 snapshot

130 markets, 92 with borrowers. 447 borrowers owe $131.8M against $154.8M supplied, at the API's USD prices. Monad's markets have recorded no bad debt so far. Each result below states what would have to happen for depositors to lose money. A "jump" is the oracle moving from today's price to the shocked price in one update. A slow slide with liquidators at work leaves no bad debt in Morpho Blue, because at the liquidation point `LLTV x LIF < 1` and the collateral still covers the debt plus the incentive.

### The five largest markets

| Market | LLTV | Borrowed | Suppliers lose nothing unless | A 25% jump would cost suppliers |
| --- | --- | --- | --- | --- |
| wstETH / WETH | 94.5% | $35.4M | wstETH jumps 5% or more below WETH | $6.39M, $6.24M of it to Steakhouse Prime ETH |
| aHYPER / USDC | 77% | $34.4M | aHYPER jumps 18% or more | $0.59M, $0.35M of it to Hyperithm USDC Apex; a 50% jump, $11.2M |
| PT-USDat-14JAN2027 / USDC | 91.5% | $21.4M | the PT jumps 7% or more | $3.11M, $2.64M of it to Hyperithm USDC Apex |
| earnAUSD / USDC | 91.5% | $7.3M | earnAUSD jumps 11% or more | $1.09M, $1.07M of it to August USDC V2 |
| strUSD / AUSD | 86% | $6.1M | strUSD jumps 11% or more | $0.77M, $0.63M of it to SharpByte AUSD Tori Ecosystem |

The PT-USDat-14JAN2027 market's oracle is of a type the API does not recognise. If it prices the PT by a fixed schedule rather than the market, its loss would arrive as a hidden loss: a 25% fall in the PT's market price with the oracle unchanged leaves $2.68M unrealised.

### Collateral tokens by probable maximum loss

The PML is the loss to depositors, across every market, if the token became worthless. The smaller falls show how fast the loss builds.

| Rank | Token | Markets | PML | First loss at a jump of | 10% jump | 25% jump | 50% jump | 25% fall, oracle holds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | wstETH | 6 | $35.4M | 5% | $1.12M | $6.39M | $16.1M | $5.91M |
| 2 | aHYPER | 2 | $34.4M | 18% | 0 | $0.59M | $11.2M | $0.03M |
| 3 | PT-USDat-14JAN2027 | 1 | $21.4M | 7% | $0.12M | $3.11M | $8.77M | $2.68M |
| 4 | earnAUSD | 2 | $7.3M | 11% | 0 | $1.09M | $3.16M | $0.92M |
| 5 | strUSD | 3 | $6.1M | 11% | 0 | $0.77M | $2.32M | $0.56M |

### The largest single positions

| Borrower | Market | Debt | Health factor | Liquidatable after a fall of | Leaves bad debt after a jump of |
| --- | --- | --- | --- | --- | --- |
| `0xa024063b630d554078bbf985718b22f3c6870ee0` | wstETH / WETH | $18.5M | 1.031 | 3.0% | 6.8% |
| `0x357d2614095e05ce2aaaeeec72d52f2b29ff7384` | aHYPER / USDC | $17.1M | 1.089 | 8.1% | 24.0% |
| `0x9ca1d6e730eb9fbfd45c9ff5f0ac4e3d172d8f4d` | wstETH / WETH | $7.4M | 1.145 | 12.6% | 16.1% |
| `0x42b901fbad7d571560949eca38a6d7b477d9fe51` | earnAUSD / USDC | $7.3M | 1.066 | 6.2% | 11.9% |
| `0x46e449074b7a2287048e8b770cf866ed6afd1bd1` | PT-USDat-14JAN2027 / USDC | $6.2M | 1.076 | 7.1% | 12.8% |

For the largest position to leave bad debt, wstETH's oracle would have to move more than 6.8% against WETH in one update. Any slower fall lets liquidators close it from 3.0% on with no loss to suppliers.

### Cover limits

The cover that keeps a vault's depositors whole if any one collateral token falls by the given amount in one jump:

| Vault | Supplied to Morpho | 10% | 25% | 50% |
| --- | --- | --- | --- | --- |
| Hyperithm USDC Apex | $50.5M | $0.10M (PT-USDat-14JAN2027) | $2.64M (PT-USDat-14JAN2027) | $7.44M (PT-USDat-14JAN2027) |
| Steakhouse Prime ETH | $38.7M | $1.10M (wstETH) | $6.24M (wstETH) | $15.7M (wstETH) |
| August USDC V2 | $7.8M | 0 | $1.07M (earnAUSD) | $3.10M (earnAUSD) |
| Hyperithm cbBTC Apex | $7.7M | 0 | $0.23M (mHyperBTC) | $1.36M (mHyperBTC) |
| SharpByte AUSD Tori Ecosystem | $5.2M | 0 | $0.63M (strUSD) | $1.91M (strUSD) |

## Limits of the model

- One token fails at a time. Tokens from one issuer (aHYPER, mHYPER, aHyperBTC, mHyperBTC) or one underlying (the PT-AUSD markets) could fail together.
- The fall is a single jump at the snapshot. There is no price path, no interest accrual and no borrower adding collateral.
- Exit depth on Monad's exchanges is not measured yet, so the thin exit scenario runs only for tokens given a depth in the config.
- A vault that deposits into another vault is charged at the vault that holds the market position. The loss is not traced on to the depositing vault.
- 16% of supply by value is held by addresses that are not a Vault V2 adapter. Their losses are reported as other suppliers.
- Failure probabilities and severities in the pricing are placeholders.
