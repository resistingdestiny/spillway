//! `spillway-snapshot`: reads one Perpl market at one block through the Perpl
//! Rust SDK and writes a `spillway.snapshot/1` JSON file.

mod network;

use std::path::PathBuf;

use alloy::{
    eips::BlockId,
    providers::{Provider, ProviderBuilder},
    rpc::client::RpcClient,
    transports::layers::{RetryBackoffLayer, ThrottleLayer},
};
use anyhow::{Context, bail};
use clap::Parser;

use crate::network::Network;

#[derive(Debug, Parser)]
#[command(name = "spillway-snapshot", version, about)]
struct Args {
    /// Perpl deployment to read.
    #[arg(long, value_enum, default_value_t = Network::Mainnet)]
    network: Network,

    /// Market symbol (BTC, ETH, MON, ...) or numeric perpetual id.
    #[arg(long)]
    market: String,

    /// Block to read at. Defaults to the latest safe block.
    #[arg(long)]
    block: Option<u64>,

    /// RPC endpoint. Defaults to the public Monad RPC of the network.
    #[arg(long)]
    rpc: Option<String>,

    /// Output file. Writes to stdout when omitted.
    #[arg(long)]
    out: Option<PathBuf>,

    /// Maximum RPC requests per second.
    #[arg(long, default_value_t = 15)]
    rps: u32,
}

#[tokio::main]
async fn main() {
    if let Err(err) = run(Args::parse()).await {
        eprintln!("error: {err:#}");
        std::process::exit(1);
    }
}

async fn run(args: Args) -> anyhow::Result<()> {
    let chain = args.network.chain();
    let rpc = args
        .rpc
        .clone()
        .unwrap_or_else(|| args.network.default_rpc().to_string());

    // Public RPCs rate limit. Throttle the request rate and back off on 429s.
    let client = RpcClient::builder()
        .layer(ThrottleLayer::new(args.rps))
        .layer(RetryBackoffLayer::new(12, 250, 330))
        .connect(&rpc)
        .await
        .with_context(|| format!("connecting to RPC {rpc}"))?;
    let provider = ProviderBuilder::new().connect_client(client);

    let chain_id = provider.get_chain_id().await.context("reading chain id")?;
    if chain_id != chain.chain_id() {
        bail!(
            "RPC is on chain {chain_id}, but {} is chain {}",
            args.network.name(),
            chain.chain_id()
        );
    }

    // Pin one block number up front so every read below sees the same state.
    let block_id = args.block.map(BlockId::number).unwrap_or(BlockId::safe());
    let block = provider
        .get_block(block_id)
        .await
        .context("reading block header")?
        .context("block not found")?
        .into_header();
    eprintln!(
        "{} chain {} block {} ({})",
        args.network.name(),
        chain_id,
        block.number,
        block.timestamp
    );
    Ok(())
}
