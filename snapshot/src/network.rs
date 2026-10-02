//! The two Perpl deployments this tool can read.

use clap::ValueEnum;
use perpl_sdk::Chain;

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum Network {
    Mainnet,
    Testnet,
}

impl Network {
    pub fn name(self) -> &'static str {
        match self {
            Network::Mainnet => "mainnet",
            Network::Testnet => "testnet",
        }
    }

    /// Exchange address, collateral token and chain id come from the SDK.
    pub fn chain(self) -> Chain {
        match self {
            Network::Mainnet => Chain::mainnet(),
            Network::Testnet => Chain::testnet(),
        }
    }

    /// Public Monad RPC. It rate limits, so the provider throttles and retries.
    pub fn default_rpc(self) -> &'static str {
        match self {
            Network::Mainnet => "https://rpc.monad.xyz",
            Network::Testnet => "https://testnet-rpc.monad.xyz",
        }
    }

    /// Base URL of Perpl's public REST API.
    pub fn api_base(self) -> &'static str {
        match self {
            Network::Mainnet => "https://app.perpl.xyz/api",
            Network::Testnet => "https://testnet.perpl.xyz/api",
        }
    }
}
