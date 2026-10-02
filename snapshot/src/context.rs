//! Perpl's public REST context (`GET {api}/v1/pub/context`, no auth).
//!
//! Used to resolve the market and to cross-check the on-chain configuration.
//! It is optional: if the call fails the snapshot is still taken from the
//! chain alone, and the failure is noted in the output.

use std::time::Duration;

use alloy::transports::http::reqwest;
use anyhow::{Context as _, bail};
use serde::Deserialize;

use crate::market::matches_symbol;

#[derive(Debug, Deserialize)]
pub struct Context {
    pub chain: Chain,
    #[serde(default)]
    pub markets: Vec<Market>,
}

#[derive(Debug, Deserialize)]
pub struct Chain {
    pub chain_id: u64,
}

#[derive(Debug, Deserialize)]
pub struct Market {
    pub perpetual_id: u32,
    #[serde(default)]
    pub symbol: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub size_units: String,
    pub config: Option<MarketConfig>,
}

/// Market configuration as the API reports it. Margins are in hundredths of
/// leverage and fees in the contract's raw fee unit.
#[derive(Debug, Deserialize)]
pub struct MarketConfig {
    pub price_decimals: Option<u8>,
    pub size_decimals: Option<u8>,
    pub initial_margin: Option<u64>,
    pub maintenance_margin: Option<u64>,
    pub is_open: Option<bool>,
}

pub async fn fetch(api: &str) -> anyhow::Result<Context> {
    let url = format!("{}/v1/pub/context", api.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("spillway-snapshot/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let body = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?
        .error_for_status()
        .with_context(|| format!("GET {url}"))?
        .bytes()
        .await?;
    serde_json::from_slice(&body).with_context(|| format!("parsing {url}"))
}

impl Context {
    /// Finds the market by perpetual id or by symbol, name or size unit.
    pub fn find_market(&self, market: &str) -> anyhow::Result<&Market> {
        let found = match market.trim().parse::<u32>() {
            Ok(id) => self.markets.iter().find(|m| m.perpetual_id == id),
            Err(_) => self
                .markets
                .iter()
                .find(|m| matches_symbol(market, &[&m.symbol, &m.name, &m.size_units])),
        };
        match found {
            Some(m) => Ok(m),
            None => bail!(
                "REST context lists no market {market:?} (has: {})",
                self.markets
                    .iter()
                    .map(|m| format!("{}={}", m.perpetual_id, m.display_name()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }
}

impl Market {
    pub fn display_name(&self) -> &str {
        [&self.symbol, &self.size_units, &self.name]
            .into_iter()
            .find(|s| !s.is_empty())
            .map(String::as_str)
            .unwrap_or("?")
    }
}
