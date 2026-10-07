// Everything the app's testnet cover assumes about Monad testnet and our lending deployment, with its
// source. Addresses come from the deployment file the contracts scripts publish.

import { type Address, type Hex, defineChain } from "viem";
import deployment from "../../../contracts/deployments/monad-testnet-lending.json";

/** Monad testnet. Explorer from the deployment file. */
export const CHAIN = defineChain({
  id: deployment.chainId,
  name: "Monad Testnet",
  nativeCurrency: { name: "Testnet MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [deployment.rpc] } },
  blockExplorers: { default: { name: "Monadscan", url: deployment.explorer } },
  // Multicall3 at its canonical address, checked with eth_getCode on Monad testnet. One
  // multicall reads the whole view in a single request.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const EXPLORER = deployment.explorer;

export const ADDR = {
  morpho: deployment.contracts.morpho as Address,
  vault: deployment.contracts.vault as Address,
  usd: deployment.contracts.usd as Address,
  oracle: deployment.contracts.oracle as Address,
  collateral: deployment.contracts.collateral as Address,
};

export const MARKET_ID = deployment.market.id as Hex;
export const LLTV = BigInt(deployment.market.lltv);
/** Oracle price when the replay was seeded: the replay book's `oraclePrice`. */
export const ORACLE_START = BigInt(deployment.market.oracleStartPrice);
export const REPLAY = deployment.market.replayOf;

export const POLICY_ID = BigInt(deployment.policy.id);
export const HOLDER = deployment.policy.holder as Address;

/**
 * The replayed borrowers, strictly increasing as numbers, as `claimShortfall` and
 * `marketShortfall` require (`BorrowersNotSorted` otherwise).
 */
export const BORROWERS = (deployment.borrowers as Address[]).slice().sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

/** Claim transactions already on chain, decoded on load. Older logs are out of the RPC's reach. */
export const KNOWN_CLAIMS = [deployment.events.claimShortfall as Hex];

// ------------------------------------------------------------------ the public RPC

/**
 * How often live state is read. The public RPC allows 15 requests a second, and one poll
 * is two requests (a multicall and a log query), so 10 s leaves room for every visitor.
 */
export const POLL_MS = 10_000;
/** How often a sent transaction's receipt is checked. Monad testnet makes a block in about 0.4 s. */
export const RECEIPT_POLL_MS = 2_000;
/** The public RPC refuses eth_getLogs over more than 100 blocks (error -32614). */
export const LOG_RANGE = 100n;

// ------------------------------------------------------------------ units

/** tUSD has 6 decimals (`MockUSD.decimals`). */
export const USD_DECIMALS = 6;
/** twstETH has 18 decimals (the replay book's `collateral.decimals`). */
export const COLLATERAL_DECIMALS = 18;
/** Morpho prices are loan base units per collateral base unit times 1e36 (`ConstantsLib`). */
export const ORACLE_PRICE_SCALE = 10n ** 36n;
/** Morpho's virtual supply shares and assets (`SharesMathLib`). */
export const VIRTUAL_SHARES = 10n ** 6n;
export const VIRTUAL_ASSETS = 1n;
/** Loan base units per supply share times 1e36 in a fresh market (`MorphoCoverVault.PRICE_SCALE`). */
export const FRESH_SHARE_PRICE = 10n ** 30n;

// ------------------------------------------------------------------ actions

/** What "Get test dollars" mints. `MockUSD` caps one mint at 100,000 tUSD. */
export const FAUCET_AMOUNT = 10_000n * 10n ** 6n;
/** Suggested underwriting deposit, in whole tUSD. */
export const DEFAULT_DEPOSIT = 10_000;
/** Where to get testnet MON for gas (Monad's docs). */
export const MON_FAUCET = "https://faucet.monad.xyz";
