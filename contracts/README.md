# Spillway contracts

One excess-of-loss layer between a perp market's insurance fund and auto-deleveraging (ADL), cover for depositors in Morpho Blue lending markets, and the testnet pieces both demos run on. Foundry project, Solidity 0.8.28, `evm_version = "cancun"`. Morpho Blue itself is built with its own pinned solc 0.8.19 (see [Lending cover](#lending-cover-morpho-blue)).

Bad debt is paid in this order:

1. The market's insurance fund, down to zero.
2. The Spillway layer (`CoverVault`), up to its remaining limit.
3. Winning traders, through ADL.

## Contracts

**`CoverVault`** holds one layer. Capital providers deposit the collateral token and get shares. Deposits are open until `termEnd` and capped so principal never exceeds what the layer can still lose (`limit - paidOut`). They close while the adapter has a pending shortfall, so nobody joins a layer that already owes money. Money is locked until `termEnd`. The sponsor (the exchange) funds a premium that streams to shareholders from `termStart` to `termEnd`, tracked with a per-share accumulator so a late depositor only earns from the moment they join. Holders can claim premium at any time. When the adapter reports a shortfall, anyone can call `settle()`, which pays the adapter the lowest of the shortfall, the remaining limit and the principal. After `termEnd`, holders withdraw their share of what is left plus any unclaimed premium, and `sweepUnearnedPremium()` returns premium nobody earned to the sponsor. Principal and premium are separate books, so a payout can never touch premium owed to holders.

**`MockBackstopAdapter`** stands in for one Perpl perpetual's insurance fund on testnet. Anyone can top up the fund. A scenario runner posts bad debt: the fund pays what it can, and the rest becomes `pendingShortfall`, which the vault pays down. `finalizeShortfall()` books whatever is still pending as ADL loss. Running totals (`badDebtTotal`, `fundPaid`, `layerPaid`, `adlLoss`) feed the UI's three counters. On real Perpl the top-up path would be the protocol's `xferProtocolToPerp(perpId, amount, true)`. Whether a third party can call it is an open question for the Perpl team.

**`IBackstopAdapter`** is the four functions the vault needs from a market: `asset`, `insuranceFund`, `pendingShortfall` and `receiveCover`. A real Perpl adapter would implement the same interface.

**`MockUSD`** is "Test Dollar" (tUSD), a 6-decimal testnet token with no value. Anyone can mint up to 100,000 tUSD per call, so judges can fund their own wallets.

## Units

- All money is in tUSD base units: 6 decimals, so `1e6` is one dollar.
- `premiumRate` is token units per second scaled by `1e18`. Divide by `1e18 * 1e6` for dollars per second.
- Times are unix seconds.

## Test

```sh
git submodule update --init --recursive   # once, if you cloned without --recurse-submodules
cd contracts
forge build
forge test
```

| File | What it covers |
| --- | --- |
| `test/MockUSD.t.sol` | Token metadata and the faucet cap |
| `test/MockBackstopAdapter.t.sol` | Fund first, shortfall, cover, ADL, roles |
| `test/CoverVault.deposit.t.sol` | Deposit cap, lock, share pricing, deposits blocked by exhaustion or a pending shortfall |
| `test/CoverVault.settle.t.sol` | Full loss, partial loss, no-op settle, two payouts to the limit |
| `test/CoverVault.premium.t.sol` | Streaming, time weighting, claims, top-ups, sweep |
| `test/CoverVault.fuzz.t.sol` | Payout equals min(shortfall, remaining limit, principal); premium never leaks |
| `test/CoverVault.invariant.t.sol` | Solvency and payout bounds over random action sequences |
| `test/Deploy.t.sol` | The deploy script's wiring |
| `test/lending/LendingMocks.t.sol` | MockOracle, TestToken, FixedRateIrm, our Morpho Blue deployment, the liquidation incentive factor and liquidations with and without bad debt |
| `test/lending/MorphoCoverVault.claim.t.sol` | The payout is the exact fall in what the covered shares redeem for, less the deductible, capped by the limit and by free capital. Interest alone never pays. No loss, no claim. Dust, the claim window, release, the whitelist (a market with another oracle is another id), insurable interest |
| `test/lending/MorphoCoverVault.underwriting.t.sol` | Share pricing, the withdrawal notice and its window, shares under notice stay at risk, capacity, premium streaming per policy, sweep, premium never pays a claim |
| `test/lending/MorphoCoverVault.flow.t.sol` | Full flow on a local Morpho Blue: four borrowers, a 25% depeg, liquidations, about 238k of bad debt, and the claim pays the holder's share |
| `test/lending/MorphoCoverVault.fuzz.t.sol` | Payout equals min(loss less deductible, limit, free capital) over random sizes and withdrawals; interest never pays |
| `test/lending/MorphoCoverVault.invariant.t.sol` | Solvency, premium reserve, policy limits, `activeLimit` and `paidOut` bookkeeping, and conservation of principal, over random sequences with real bad debt |
| `test/lending/Replay.t.sol` | Deploy, seed and scenario scripts in order on `replay/example.json` |

The invariant suite runs with fail-on-revert on. It checks after every call that the vault's balance covers principal plus the premium reserve, that the reserve covers what holders can claim, that no payout passes min(shortfall, remaining limit, principal), that no deposit is accepted while a shortfall is pending, and that the waterfall adds up to all bad debt.

## Deploy to Monad testnet

Monad testnet is chain `10143`, RPC `https://testnet-rpc.monad.xyz` (named `monad_testnet` in `foundry.toml`). You need testnet MON for gas from the Monad faucet (see docs.monad.xyz).

```sh
cd contracts
cast wallet import spillway --interactive        # store the deployer key in a keystore

# Settings, money in whole tUSD. These are the defaults.
export TERM_DAYS=30 LIMIT=250000 INSURANCE_SEED=178373 PREMIUM=5000 PERP_ID=1
# export RUNNER=0x...   # defaults to the deployer

# Dry run first, then broadcast.
forge script script/Deploy.s.sol --rpc-url monad_testnet --account spillway
forge script script/Deploy.s.sol --rpc-url monad_testnet --account spillway --broadcast --slow
```

The deployer becomes the adapter owner, the runner (unless `RUNNER` is set) and the vault's sponsor. The script deploys the three contracts, sets the runner, wires the vault into the adapter once, seeds the insurance fund and funds the premium. Addresses are printed and kept in `broadcast/Deploy.s.sol/10143/run-latest.json`:

```sh
jq -r '.transactions[] | select(.transactionType=="CREATE") | "\(.contractName) \(.contractAddress)"' \
  broadcast/Deploy.s.sol/10143/run-latest.json
```

Verify on MonadVision (Sourcify):

```sh
forge verify-contract <address> CoverVault --chain 10143 \
  --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/
```

## Demo flow with cast

```sh
RPC=https://testnet-rpc.monad.xyz
cast send $USD "mint(address,uint256)" $ME 100000000000 --rpc-url $RPC --account me     # 100k tUSD
cast send $USD "approve(address,uint256)" $VAULT 100000000000 --rpc-url $RPC --account me
cast send $VAULT "deposit(uint256)" 100000000000 --rpc-url $RPC --account me

# The runner posts a cascade bigger than the fund. The fund pays first.
cast send $ADAPTER "reportBadDebt(uint256)" 228373000000 --rpc-url $RPC --account spillway
cast send $VAULT "settle()" --rpc-url $RPC --account me                                 # anyone
cast send $ADAPTER "finalizeShortfall()" --rpc-url $RPC --account spillway              # rest goes to ADL

cast call $ADAPTER "fundPaid()(uint256)" --rpc-url $RPC
cast call $ADAPTER "layerPaid()(uint256)" --rpc-url $RPC
cast call $ADAPTER "adlLoss()(uint256)" --rpc-url $RPC
```

## Design notes

- Cover runs from `termStart` to `termEnd`. Outside that window `settle()` does nothing, so a shortfall left unsettled at expiry is not paid by the layer. A keeper should call `settle()` right after each cascade.
- Deposits close while the adapter has a pending shortfall (`ShortfallPending(amount)`), so a newcomer never shares a loss that happened before they joined. They reopen once `settle()` clears the shortfall, or, if the vault cannot pay all of it, once the runner calls `finalizeShortfall()`. `availableCapacity()` reads 0 in the meantime.
- Once principal hits zero with shares outstanding, deposits close for the rest of the term, even if limit remains.
- Premium keeps streaming to holders after a loss, including a total loss. The premium buys the risk for the whole term.
- Shares are internal balances and cannot be transferred. That keeps premium accounting simple.
- Rounding always favours the vault. Holders can lose a few millionths of a dollar to rounding. Part of that dust goes back to the sponsor in the sweep and the rest stays in the vault.
- No upgradeability, no admin on the vault. Every term is fixed at deploy.

## Lending cover (Morpho Blue)

The design is in `docs/LENDING.md` ("Cover" and "Testnet replay"). A policy covers one holder's supply shares in one listed Morpho Blue market. It pays when the market's supply share price falls, which happens only when Morpho writes off bad debt in `liquidate`. No keeper or vote decides anything.

**`MorphoCoverVault`** (`src/lending/`). Underwriters deposit the loan token (tUSD on testnet) and get shares, as in `CoverVault`. The owner lists Morpho market ids, each with an annual premium rate in basis points of the limit. Anyone can buy a policy for a holder: it covers some of the holder's supply shares (never more than the holder supplies and has not already covered) for `policyTerm`, with a limit and a deductible. The premium is paid up front and streams to underwriters over the term. The vault backs every live limit in full when it sells, so a new limit must fit in `capacity()`, which is principal less live limits less principal under withdrawal notice. At inception the policy records the market's `totalSupplyAssets` and `totalSupplyShares` after accruing interest. That pair, with Morpho's virtual shares and assets, is the start share price. `claim(policyId)` is permissionless. It accrues interest on Morpho, then pays the holder

```
loss = toAssetsDown(shares, start totals) - toAssetsDown(shares, totals now)
paid = min(loss - deductible, limit) - already paid, then capped by free capital
```

where `shares` is the lower of the covered shares and what the holder still supplies, and `toAssetsDown` is Morpho's own `SharesMathLib`. So the payout is exactly the fall in what the covered shares redeem for, rounded as Morpho rounds a withdrawal. Claims can repeat as a loss grows. A claim under `dustThreshold` reverts. Underwriters give notice with `requestWithdrawal` and can `withdraw` once `withdrawalNotice` has passed, for `withdrawalWindow`. The notice is longer than the claim window, and shares under notice stay at risk. Every state change emits an event, and every refusal is a custom error.

**`MockOracle`** implements Morpho's `IOracle`. Its owner sets `price()`, scaled by 1e36 as Morpho expects: one base unit of collateral in base units of the loan token. For 18-decimal collateral worth $4,000 in 6-decimal tUSD that is `4000e24`.

**`TestToken`** is a faucet token for collateral, for example "Test wstETH" (twstETH, 18 decimals).

**`FixedRateIrm`** is our interest rate model: one borrow rate per second for every market. Morpho only accepts IRMs its owner enabled, and on our own deployment we are the owner.

**`script/lending/LendingConfig.sol`** holds every lending assumption with its source: the mainnet Morpho addresses, the LLTVs to enable, the IRM rate and the vault's terms.

### Morpho Blue on Monad testnet

Morpho Blue runs on Monad mainnet (chain 143) at `0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee` with the AdaptiveCurveIrm at `0x09475a3D6eA8c314c592b1a3799bDE044E2F400F` (docs.morpho.org, addresses page). The same page lists no Monad testnet deployment, and chain 10143 has no code at either address. So the replay deploys its own Morpho Blue from the official repository, pinned as the submodule `lib/morpho-blue` at commit `8e26ca6` (main, 9 September 2026). That commit's contract logic is the audited v1.0.0 release. The only differences are formatting, comments and the licence header. `script/morpho/MorphoBlue.sol` pulls `Morpho.sol` into the build, which compiles it with solc 0.8.19, via-IR and 999,999 optimizer runs, as Morpho's own `foundry.toml` does. Tests and scripts deploy it with `deployCode("Morpho.sol:Morpho")`. Our IRM and every LLTV used on mainnet (77%, 86%, 91.5%, 94.5%, 96.5%, 98%) are enabled at deploy.

### Licence

The repository is MIT. Morpho Blue at the pinned commit is GPL-2.0-or-later. Version v1.0.0 marked `Morpho.sol` BUSL-1.1, so we pin the later relicensed commit rather than the tag. The files that import Morpho Blue's interfaces or libraries are marked GPL-2.0-or-later: `MorphoCoverVault`, `MockOracle`, `FixedRateIrm`, the lending scripts and the lending tests. Everything else, including `TestToken`, `LendingConfig` and the Perpl contracts, stays MIT.

### Replay input (`spillway.morpho-replay/1`)

`script/lending/SeedMarket.s.sol` reads one market's book from a JSON file. The lending engine will write these from `fixtures/morpho/`. `replay/example.json` is a small illustrative book.

```jsonc
{
  "schema": "spillway.morpho-replay/1",
  "source": { "chainId": 143, "block": 111058609, "marketId": "0x...", "scale": 0.01 }, // provenance, not read
  "collateral": { "name": "Test wstETH", "symbol": "twstETH", "decimals": 18 },
  "lltv": "860000000000000000",              // 1e18 scale, one of the enabled LLTVs
  "oraclePrice": "4000000000000000000000000000", // Morpho oracle scale (see MockOracle)
  "holderIndex": 0,                          // the supplier whose supply is covered
  "suppliers": [ { "assets": "1500000000000" } ],  // tUSD base units (6 decimals)
  "borrowers": [ { "collateral": "300000000000000000000", "borrowAssets": "1020000000000" } ]
}
```

Every amount is a decimal string in base units of the testnet tokens, already scaled. The loan token is always tUSD (6 decimals). Supplier `holderIndex` supplies on behalf of `HOLDER` (default: the broadcaster). The other suppliers supply on behalf of addresses derived from the market id, which nobody holds a key to. Each borrower is a `ReplayBorrower` contract that mints its test collateral, posts it and borrows, sending the loan to the broadcaster. A borrow above what the oracle allows is trimmed to the most Morpho accepts, and logged.

### Run the replay

On a local chain:

```sh
anvil &
RPC=http://127.0.0.1:8545
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil's first account
F="--rpc-url $RPC --private-key $KEY --broadcast --slow --gas-estimate-multiplier 200"

forge script script/lending/DeployLending.s.sol $F      # prints export lines for MORPHO, IRM, USD, VAULT
export MORPHO=... IRM=... USD=... VAULT=...
forge script script/lending/SeedMarket.s.sol $F         # REPLAY_JSON defaults to replay/example.json
DROP_BPS=2500 forge script script/lending/Scenario.s.sol $F
```

`SeedMarket` writes `replay/state-<chain id>.json`, which `Scenario` reads. Optional settings for `SeedMarket`: `REPLAY_JSON`, `REPLAY_STATE`, `HOLDER`, and `CAPITAL`, `COVER_LIMIT` and `DEDUCTIBLE` in whole tUSD (capital and limit default to the holder's supply, deductible to 0). `Scenario` takes `DROP_BPS` (default 3000) and `REPLAY_STATE`. On the example book a 25% drop liquidates three of the four borrowers, Morpho writes off 239,299.999998 tUSD, and the holder, with half the supply, is paid its loss of 119,649.999999.

The scenario prints figures from forge's simulation, where every call happens at one timestamp. On a real chain each transaction lands in its own block, so a little interest accrues between them, which lifts the share price and shrinks the loss by a few hundred base units. The claim reads the chain, so it pays the loss as it stands on chain. The `Claimed` event has the exact figure. Use `--slow` and the higher gas estimate: the first `accrueInterest` costs more on chain than in the simulation, where no time has passed.

### Deploy the lending stack to Monad testnet

Ready but not run. It needs testnet MON for gas, and the deployer becomes the owner of Morpho Blue, the vault and each replay's oracle.

```sh
cd contracts
export USD=0x...      # optional: reuse the Perpl demo's MockUSD instead of deploying a new one
forge script script/lending/DeployLending.s.sol --rpc-url monad_testnet --account spillway
forge script script/lending/DeployLending.s.sol --rpc-url monad_testnet --account spillway \
  --broadcast --slow --gas-estimate-multiplier 200
```

Then run `SeedMarket` and `Scenario` the same way with `--rpc-url monad_testnet --account spillway`. Seeding a large book is one transaction per faucet mint, supply and borrower.

### Lending design notes

- The trigger is the share price, so interest earned since inception absorbs a loss first. Cover protects what the shares were worth on the day it was bought.
- A loss that nobody has realised (an underwater borrower not yet liquidated) does not pay. Anyone can realise it by liquidating, which a liquidator does for profit whenever the collateral still covers the debt times the incentive. `claimable(policyId)` previews the payout with interest accrued in the view.
- A listed id pins all five market parameters, so the oracle, IRM and LLTV are listed with it. A market that swaps in another oracle is another id and is not covered.
- A policy can be claimed until `claimWindow` after its end. The share price has no history on chain, so a claim inside the window pays on the price at the time of the claim. In effect, cover runs to the end of the window. With the default one-day window on a 30-day term we price on the term.
- A withdrawal request that has lapsed still counts as under notice, reducing capacity, until it is cancelled or replaced. That is the cautious side.
- Policies are sold permissionlessly at the listed rate. Delisting stops sales at once, and policies already sold stay claimable.
- Free capital is principal. Premium is a separate book and never pays a claim.
- Open: cover can be bought after a borrower is under water but before anyone liquidates, so the buyer is covered for a loss already in sight. The owner should delist a market as soon as its collateral is in trouble. A waiting period before cover attaches would close this.
- Open: a deposit made after a loss is realised but before it is claimed shares that loss. Claims are permissionless, so a careful depositor claims open losses first.
- Amounts are in loan token base units. `premiumBps` is a year's premium in basis points of the limit. `sharePriceOf` is base units per share times 1e36, for display; claims use the recorded totals.
