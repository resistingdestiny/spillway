# Spillway contracts

One excess-of-loss layer between a perp market's insurance fund and auto-deleveraging (ADL), plus the testnet pieces the demo runs on. Foundry project, Solidity 0.8.28, `evm_version = "cancun"`.

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
