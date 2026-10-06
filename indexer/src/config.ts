// Every constant the indexer depends on, in one place, with where it comes from.

export const indexerConfig = {
  chainId: 143,

  morpho: {
    /** Morpho Blue on Monad mainnet. docs.morpho.org, addresses page; also contracts/script/lending/LendingConfig.sol. */
    address: "0xd5d960e8c380b724a48ac59e2dff1b2cb4a1eaee",
    /**
     * The block that deployed it: eth_getCode is empty at 31907456 and holds the contract at 31907457,
     * whose first log is the constructor's SetOwner (tx 0x3b550936...b18812f). Read from rpc1.monad.xyz.
     */
    deploymentBlock: 31907457,
  },

  hypersync: {
    /** Envio HyperSync for Monad mainnet. docs.envio.dev, HyperSync supported networks. */
    url: "https://monad.hypersync.xyz",
    /**
     * HyperSync rejects queries without an API token (HTTP 401). A free token comes from
     * app.envio.dev/api-tokens after signing in. docs.envio.dev, HyperSync API tokens.
     */
    tokenEnv: "ENVIO_API_TOKEN",
  },

  rpc: {
    /**
     * Monad's public RPC that answers eth_getLogs over any block range up to 10,000 logs per response
     * (its own error message). rpc.monad.xyz allows 100 blocks, rpc2 and rpc3 less than 100,000.
     * Used when no HyperSync token is set, and for eth_call at the snapshot block.
     */
    url: "https://rpc1.monad.xyz",
    /** Blocks per eth_getLogs request to start from. Halved when a response would exceed the cap. */
    logSpan: 2_000_000,
  },
} as const;
