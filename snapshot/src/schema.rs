//! Output contract: `spillway.snapshot/1`, as specified in docs/ARCHITECTURE.md.
//!
//! Money is in dollars of the 6-decimal collateral token. Prices and sizes are
//! already scaled by the market's price and lot decimals.

use serde::Serialize;

pub const SCHEMA: &str = "spillway.snapshot/1";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema: &'static str,
    pub network: &'static str,
    pub chain_id: u64,
    pub exchange: String,
    pub block: u64,
    pub block_timestamp: u64,
    pub taken_at: String,
    pub source: Source,
    pub market: Market,
    pub positions: Vec<Position>,
    pub book: Book,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// Crate name and version of the Perpl SDK used to read the chain.
    pub sdk: String,
    /// Exchange contract revision the SDK targets.
    pub dex_revision: String,
    /// Version the deployed exchange contract reports.
    pub contract_version: Option<String>,
    /// Base URL of Perpl's public REST API.
    pub api: String,
    /// Anything a reader should know about this snapshot.
    pub notes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Market {
    pub perp_id: u32,
    pub symbol: String,
    pub name: String,
    pub price_decimals: u8,
    pub lot_decimals: u8,
    pub mark_price: f64,
    pub oracle_price: f64,
    pub last_price: f64,
    /// MMR = notional * this.
    pub maintenance_margin_fraction: f64,
    pub initial_margin_fraction: f64,
    pub taker_fee: f64,
    pub maker_fee: f64,
    /// In lots of the asset.
    pub long_open_interest: f64,
    pub short_open_interest: f64,
    pub insurance_fund: f64,
    pub position_balance: f64,
    pub liquidation_split: LiquidationSplit,
    /// Share of fees routed to the insurance fund.
    pub fee_insurance_share: f64,
    pub funding_rate: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiquidationSplit {
    pub trader: f64,
    pub insurance: f64,
    pub protocol: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub account_id: u32,
    pub side: &'static str,
    pub size: f64,
    pub entry_price: f64,
    pub deposit: f64,
    pub premium_pnl: f64,
    pub delta_pnl: f64,
    pub liquidation_price: f64,
    pub bankruptcy_price: f64,
}

/// Price levels as `[price, size, orders]`, best first.
#[derive(Debug, Serialize)]
pub struct Book {
    pub bids: Vec<(f64, f64, u32)>,
    pub asks: Vec<(f64, f64, u32)>,
}

/// Turns an SDK fixed-point decimal into a JSON number.
///
/// Goes through the decimal string, so the f64 is the closest one to the exact
/// on-chain value and prints back as the same short decimal.
pub fn num(value: impl std::fmt::Display) -> f64 {
    let text = value.to_string();
    text.parse::<f64>()
        .unwrap_or_else(|_| panic!("SDK decimal {text:?} is not a number"))
}
