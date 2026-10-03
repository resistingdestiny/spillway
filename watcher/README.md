# Spillway watcher

The trigger. Two processes play the engine's forecast onto the contracts and pay the layer out.

- **Runner** (`src/runner.ts`) reads the chain (insurance fund, what the vault can still pay), runs the engine from that same start, and sends the engine's money flow to the mock adapter in time order: each `fund_income` becomes `adapter.fundInsurance(amount)` and each fill's bad debt becomes `adapter.reportBadDebt(amount)`. It waits for the keeper, then calls `adapter.finalizeShortfall()` if anything is still pending, so the rest is booked as ADL.
- **Keeper** (`src/watcher.ts`) watches the adapter for `Shortfall` events, with a poll of `pendingShortfall()` as a fallback, calls `vault.settle()` at once and logs each `LayerPayout` as a JSON line. It runs as its own process with its own key, as a keeper bot (or later a Chainlink CRE workflow) would.

## Run it

```sh
pnpm install                                    # from the repo root
git submodule update --init                     # once, for contracts/lib
(cd contracts && forge build)                   # the e2e reads bytecode from contracts/out
pnpm --filter @spillway/watcher test            # unit tests: rounding and the event to transaction mapping
pnpm --filter @spillway/watcher e2e             # all three scenarios on a local anvil
pnpm --filter @spillway/watcher e2e --scenario oi10x-gap18 --batch compact
```

The e2e starts anvil on a free port. For each scenario it deploys MockUSD, the adapter (fund seeded with the snapshot's $178,387.845452) and the vault (term starts now, 30 days, limit $250,000, deployer as sponsor), funds a $5,000 premium, has one LP deposit the whole limit, starts the keeper, runs the scenario and compares. Reports go to `reports/<scenario>.json`. It exits 1 if any check fails.

## Rounding and tolerance

Each engine amount is converted on its own: take the shortest decimal that prints the number (what `JSON.stringify` shows) and round it half up to 6 decimals. So each event is off by at most $0.0000005. That error also moves the fund balance, which can carry into later draws, so every total is within **$0.000001 per money event**: `|on chain - engine| <= events x $0.000001`. A second check replays the contracts' integer arithmetic on the rounded transactions, and the chain must match that to the unit.

## Results

Real BTC snapshot from Perpl mainnet (block 109,992,422), engine defaults (Perpl's ADL order, a 10 minute fall). The fund covers an orderly fall even at 30x today's open interest, so the layer and traders scenarios use an instant gap (`stress.shockSeconds = 1`).

| Scenario | Engine config | Band | Bad debt | Fund paid | Layer paid | ADL | Largest diff | Tolerance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `oi1x-drop20` today's OI, 20% fall | default | fund | 1,226.079936 | 1,226.079936 | 0 | 0 | $0.0000038 | $0.000120 |
| `oi10x-gap18` 10x OI, 18% gap | default + shockSeconds 1 | layer | 325,768.400281 | 178,389.756608 | 147,378.643673 | 0 | $0.0001207 | $0.000677 |
| `oi10x-gap25` 10x OI, 25% gap | default + shockSeconds 1 | traders | 777,118.414285 | 178,387.845452 | 250,000.000000 | 348,730.568833 | $0.0000031 | $0.000116 |

Money is as booked on chain, in tUSD. All eight rows per scenario (bad debt, fund, layer on the adapter and in the vault, ADL, fund income, fund at end, remaining limit) are within tolerance and equal the integer replay. The 18% gap's larger diff is real rounding, not drift: 242 identical fund incomes of $1.2159005875629476 each round up by $0.00000041.

Transactions and gas for each scenario: every runner and keeper transaction, including the runner's faucet mint and approve. Setup (deploy, seed, premium, LP deposit) is about 3.42M gas more.

| Scenario | `step` batching (default) | `compact` batching |
| --- | --- | --- |
| `oi1x-drop20` | 85 txs, 4,188,288 gas | 4 txs, 214,284 gas |
| `oi10x-gap18` | 573 txs, 28,712,757 gas | 7 txs, 447,457 gas |
| `oi10x-gap25` | 6 txs, 402,752 gas | 6 txs, 402,752 gas |

Each keeper payout landed 2 to 7 blocks after the shortfall that triggered it, across runs (anvil mines one block per transaction, and the runner keeps sending meanwhile).

## Batching

- `step` (default) keeps the engine's order of income and draws. Consecutive events of the same kind in one engine step are merged, which gives the same fund path.
- `event` sends one transaction per engine event.
- `compact` folds runs of events into at most two calls while the fund ends each run at the engine's balance. Totals match `step` to the unit. Use it on a real network, where each transaction costs time and gas.

## Monad testnet

Nothing is deployed yet. The scripts read a deployment file instead of deploying.

```sh
cd contracts && forge script script/Deploy.s.sol --rpc-url monad_testnet --account spillway --broadcast --slow
pnpm --filter @spillway/watcher deployment ../contracts/broadcast/Deploy.s.sol/10143/run-latest.json
# an LP deposits into the vault (contracts/README.md has the cast commands)
cp watcher/.env.example watcher/.env            # paths and URLs only
pnpm --filter @spillway/watcher watcher         # keeper, leave it running
pnpm --filter @spillway/watcher runner --scenario oi10x-gap18 --batch compact --dry-run
pnpm --filter @spillway/watcher runner --scenario oi10x-gap18 --batch compact --report reports/testnet-oi10x-gap18.json
```

Keys are read from files named by `RUNNER_KEY_FILE` and `KEEPER_KEY_FILE` (lines like `DEPLOYER_PK=0x...`) and never printed. Give the keeper its own account so the two processes never share a nonce. Runs on testnet add up: the runner starts the engine from the fund and layer it finds on chain and compares the change. The deployment shape is in `deployments/monad-testnet.example.json`.
