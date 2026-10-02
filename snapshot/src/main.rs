//! `spillway-snapshot`: reads one Perpl market at one block through the Perpl
//! Rust SDK and writes a `spillway.snapshot/1` JSON file.

mod market;
mod network;
mod schema;

use std::{io::Write, path::PathBuf};

use alloy::{
    eips::BlockId,
    providers::{Provider, ProviderBuilder},
    rpc::client::RpcClient,
    transports::layers::{RetryBackoffLayer, ThrottleLayer},
};
use anyhow::{Context, bail};
use clap::Parser;
use fastnum::UD64;
use perpl_sdk::state::SnapshotBuilder;

use crate::{network::Network, schema::num};

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

    /// Positions and orders read per multicall. The SDK default fits Monad's
    /// eth_call gas cap, and the SDK halves a batch that still fails.
    #[arg(long)]
    batch: Option<usize>,
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
    let block_number = block.number;

    let perp_id =
        market::resolve_onchain(&chain, &provider, BlockId::number(block_number), &args.market)
            .await?;
    eprintln!(
        "reading {} perp {perp_id} at block {block_number}",
        args.network.name()
    );

    // One SDK snapshot: the perpetual's parameters, prices and full L3 book,
    // plus every open position on it, all at the pinned block.
    let mut builder = SnapshotBuilder::new(&chain, provider.clone())
        .with_perpetuals(vec![perp_id])
        .with_all_positions()
        .at_block(BlockId::number(block_number));
    if let Some(batch) = args.batch {
        builder = builder
            .with_positions_per_batch(batch)
            .with_orders_per_batch(batch);
    }
    let exchange = builder.build().await.context("building SDK snapshot")?;
    let perp = exchange
        .perpetuals()
        .get(&perp_id)
        .with_context(|| format!("perpetual {perp_id} missing from the SDK snapshot"))?;

    // Every open position on this perpetual, in account order.
    let mut positions: Vec<schema::Position> = exchange
        .accounts()
        .values()
        .filter_map(|account| account.positions().get(&perp_id))
        .map(|p| schema::Position {
            account_id: p.account_id(),
            side: if p.r#type().is_long() { "long" } else { "short" },
            size: num(p.size()),
            entry_price: num(p.entry_price()),
            deposit: num(p.deposit()),
            premium_pnl: num(p.premium_pnl()),
            delta_pnl: num(p.delta_pnl()),
            liquidation_price: num(p.liquidation_price()),
            bankruptcy_price: num(p.bankruptcy_price()),
        })
        .collect();
    positions.sort_by_key(|p| p.account_id);

    // The SDK stores margins as leverage (notional / requirement), so the
    // fraction of notional is its inverse.
    let fraction = |leverage: UD64| {
        if leverage == UD64::ZERO { 0.0 } else { num(UD64::ONE / leverage) }
    };

    let market = schema::Market {
        perp_id,
        symbol: perp.symbol(),
        name: perp.name(),
        price_decimals: perp.price_converter().decimals(),
        lot_decimals: perp.size_converter().decimals(),
        mark_price: num(perp.mark_price()),
        oracle_price: num(perp.oracle_price()),
        last_price: num(perp.last_price()),
        maintenance_margin_fraction: fraction(perp.maintenance_margin()),
        initial_margin_fraction: fraction(perp.initial_margin()),
        taker_fee: num(perp.taker_fee()),
        maker_fee: num(perp.maker_fee()),
        long_open_interest: num(perp.open_interest()),
        short_open_interest: 0.0,
        insurance_fund: 0.0,
        position_balance: 0.0,
        liquidation_split: schema::LiquidationSplit::default(),
        fee_insurance_share: 0.0,
        funding_rate: num(perp.funding_rate()),
    };

    let instant = exchange.instant();
    let snapshot = schema::Snapshot {
        schema: schema::SCHEMA,
        network: args.network.name(),
        chain_id,
        exchange: chain.exchange().to_string(),
        block: instant.block_number(),
        block_timestamp: instant.block_timestamp(),
        taken_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        source: schema::Source {
            sdk: format!("perpl-sdk {}", env!("PERPL_SDK_VERSION")),
            dex_revision: perpl_sdk::abi::DEX_REVISION.trim().to_string(),
            contract_version: exchange.contract_version().map(|v| v.to_string()),
            api: String::new(),
            notes: Vec::new(),
        },
        market,
        positions,
        book: schema::Book::default(),
    };

    let mut json = serde_json::to_string_pretty(&snapshot)?;
    json.push('\n');
    match &args.out {
        Some(path) => std::fs::write(path, json)
            .with_context(|| format!("writing {}", path.display()))?,
        None => std::io::stdout().write_all(json.as_bytes())?,
    }
    eprintln!(
        "block {} positions {} mark {}",
        snapshot.block,
        snapshot.positions.len(),
        snapshot.market.mark_price
    );
    Ok(())
}
