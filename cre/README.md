# Spillway keeper on Chainlink CRE

A Chainlink Runtime Environment (CRE) workflow that keeps watch over Spillway's Morpho cover on Monad testnet. On a cron trigger it reads what each listed policy is owed from `MorphoCoverVault`. When a loss clears the vault's dust threshold, it claims the loss for the holder through the CRE forwarder.

## Why it matters

Morpho writes off bad debt only when someone liquidates. On Monad, liquidators often cannot sell the collateral at size: selling $100k of wstETH costs 18.6%, and several collateral tokens have no route at all (`docs/RESEARCH.md`, section 3). After a markdown, borrowers sit under water and nobody liquidates them. The loss is real, but it never reaches Morpho's share price.

`MorphoCoverVault.claimShortfall` pays that unrealised loss. Anyone can prove it from Morpho's positions and the market's own oracle. But someone has to notice the loss, list the borrowers and send the claim before the claim window closes. This workflow does that on a schedule, run by a decentralised oracle network rather than by one server. It adds no trust: both claim paths are permissionless and pay the policyholder, and the receiver can do nothing else.

## What it does

Every 10 minutes (`config.json`, `schedule`):

1. Reads `dustThreshold()` from the vault, at the last finalized block, with CRE's EVM read capability.
2. For each listed policy, reads `claimableShortfall(policyId, borrowers)` and `claimable(policyId)`. The borrower list comes from `contracts/deployments/monad-testnet-lending.json`, in strictly increasing order, as the vault requires.
3. Decides per policy (`keeper.ts`, `decide`):
   - nothing due, or less than the dust threshold: nothing to send;
   - the shortfall due is above the realised due: some loss is still unwritten, so `claimShortfall` with the borrowers;
   - the two are equal: the whole loss is realised, so `claim`, without the borrower reads.
4. If any policy is due, it encodes one report, `abi.encode(Claim[])`, has the DON sign it, and writes it to `CoverKeeperReceiver` through the forwarder. With no receiver configured, it logs the report and writes nothing.

`contracts/src/lending/CoverKeeperReceiver.sol` receives the report. It implements CRE's `IReceiver` (`onReport(bytes metadata, bytes report)`, with ERC165), so the forwarder will deliver to it.
- It accepts calls from the forwarder only.
- When set at deploy, it checks the workflow owner and name in the metadata.
- It calls `claimShortfall` for a claim with borrowers, and `claim` for one without.
- Each claim runs in its own `try`, so one that has gone stale (already paid by someone else, or under the dust threshold since the read) is logged as `ClaimFailed` and does not block the others.
- It holds no funds and has no owner.

## Layout

| Path | What it is |
| --- | --- |
| `project.yaml` | CRE project settings: the Monad testnet RPC |
| `keeper/workflow.yaml` | Workflow name and artifacts for the `monad-testnet` target |
| `keeper/config.json` | Every setting the workflow uses, with its source under `sources` |
| `keeper/keeper.ts` | Config schema, the vault ABI, the decision and the report encoding |
| `keeper/workflow.ts` | The cron handler: reads, decides, reports |
| `keeper/main.ts` | Entry point compiled to WASM |
| `keeper/keeper.test.ts` | Unit tests on the CRE SDK's test runtime, with the vault mocked |
| `keeper/keeper.live.test.ts` | The workflow's read path against the real deployment |
| `../contracts/src/lending/CoverKeeperReceiver.sol` | The receiver |
| `../contracts/test/lending/CoverKeeperReceiver.t.sol` | Receiver tests on a local Morpho Blue |
| `../contracts/test/lending/CoverKeeperReceiver.fork.t.sol` | The write path through Chainlink's MockKeystoneForwarder on a fork of Monad testnet |

## Run it

Needs [Bun](https://bun.sh) 1.4 or newer (the CRE TypeScript SDK compiles with it), Foundry, and the [CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation) v1.30.0 or newer for Monad testnet. Built with CLI v1.37.0 and `@chainlink/cre-sdk` 1.23.0.

```bash
cd cre/keeper
bun install
bun test               # unit tests, offline
bun run typecheck
bun run live           # the read path against MorphoCoverVault on Monad testnet
cd ..
cre workflow build keeper --target monad-testnet -o keeper.wasm   # compiles to WASM, no login needed
```

`bun run live` runs the workflow's own `onCron` on the SDK's test runtime. Each EVM read it makes is answered with an `eth_call` to Monad testnet, all at one finalized block. The calldata, the block choice, the decoding and the decision are the workflow's. Only the transport is not CRE's. On 6 October 2026 it printed:

```
policy 1: shortfall due 0, realised due 0, dust 1000000: nothing due
Monad testnet, finalized block 68772127, 3 reads of 0x8af0Cc6D3bD243509F3c7cBaF4993456E9cd1653
```

Policy 1 was paid its shortfall in [this transaction](https://testnet.monadscan.com/tx/0x78d33f221e1a5512211d2bc830ca0ab1236cab0816ed7940fa5f0477580bba1a). Since then, interest grows the borrowers' debt and the holder's supply alike, so the due moves by a few millionths of a tUSD at most, far under the one tUSD dust threshold.

The write path runs on a fork of Monad testnet, through Chainlink's MockKeystoneForwarder at its Monad testnet address. That is the forwarder `cre workflow simulate --broadcast` writes through:

```bash
cd contracts
MONAD_FORK=1 forge test --match-path test/lending/CoverKeeperReceiver.fork.t.sol -vv
```

It deploys a receiver on the fork only, marks the collateral down a further 10%, and delivers the report the workflow would send. The vault pays the holder 28,803.04 tUSD, its share of the new shortfall. Nothing is broadcast.

### With CRE's simulator

`cre workflow simulate` needs a CRE account. Log in once with `cre login` (browser), or set `CRE_API_KEY`. Then, from `cre/`:

```bash
cre workflow simulate keeper --target monad-testnet --non-interactive --trigger-index 0
```

This runs the cron handler once in the CRE engine, with real reads on Monad testnet. As deployed, the expected result is `nothing due`. To exercise the write path in the simulator as well:

1. Deploy `CoverKeeperReceiver` on Monad testnet with the simulation forwarder from `config.json` (`forwarders.simulation`), the vault, and zero for the workflow owner and name. The simulation forwarder sends no workflow identity.
2. Put its address in `config.json` as `receiver`.
3. Make a policy due. The replay oracle's owner marks the collateral down again with `MockOracle.setPrice`, as the fork test does.
4. Run `cre workflow simulate keeper --target monad-testnet --broadcast`. It sends the write from the key in `CRE_ETH_PRIVATE_KEY` (in `.env`), which needs testnet MON for gas.

The MockKeystoneForwarder checks no signatures, so anyone can deliver a report through it. A receiver bound to it can still only make claims that anyone could make, and the vault pays the holder.

## Deploying the workflow

Not done. It needs:

1. A CRE account with deploy access (`cre account access`) and `cre login`.
2. A `CoverKeeperReceiver` on Monad testnet with the production KeystoneForwarder (`forwarders.production`). Pass the workflow owner's address and the name `spillway-keeper` in CRE's 10-byte encoding: the first ten hex characters of its SHA-256, as ASCII, `0x32636464653030663062`. The receiver then accepts reports from this workflow only.
3. That receiver's address as `receiver` in `config.json`.
4. `cre workflow deploy keeper --target monad-testnet`, then `cre workflow activate`.

The receiver needs no funds: the DON's transmitter sends the write and pays its gas, and the vault pays the claim. A policy's claim window closes one day after its term ends, so the workflow must be live before then.

## Settings and limits

Every setting is in `keeper/config.json`, and its `sources` object gives the source of each. `keeper.test.ts` checks that every setting has a source and that the vault, policy and borrowers match the deployment file. Limits that shape the design:

- CRE allows 15 EVM reads per execution. That is one for the dust threshold and two per policy, so at most 7 policies per run. The config schema refuses more.
- A read request is capped at 5 KB, which bounds one `claimableShortfall` call at about 150 borrowers.
- Monad charges the gas limit, not the gas used, so `gasLimit` is sized from the one live `claimShortfall` over these 17 borrowers (807,026 gas), with headroom, and no more.
- Reads use the last finalized block, so every node in the DON sees the same state.
