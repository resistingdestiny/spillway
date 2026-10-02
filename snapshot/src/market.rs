//! Resolves `--market` (a symbol or a perpetual id) to a perpetual id.

use alloy::{eips::BlockId, primitives::U256, providers::Provider};
use anyhow::{Context, bail};
use perpl_sdk::{Chain, abi::dex, types::PerpetualId};

/// True when `want` names a market called `symbol` or `name`, ignoring case
/// and a trailing " Perp" ("BTC" matches "BTC Perp").
pub fn matches_symbol(want: &str, candidates: &[&str]) -> bool {
    let want = want.trim();
    candidates.iter().any(|c| {
        let c = c.trim();
        !c.is_empty()
            && (c.eq_ignore_ascii_case(want)
                || c.strip_suffix(" Perp")
                    .is_some_and(|s| s.eq_ignore_ascii_case(want)))
    })
}

/// Resolves the market from the chain alone: the SDK lists every perpetual the
/// exchange reports, then each one's name and symbol is read at `block_id`.
pub async fn resolve_onchain<P: Provider + Clone>(
    chain: &Chain,
    provider: &P,
    block_id: BlockId,
    market: &str,
) -> anyhow::Result<PerpetualId> {
    let listed = perpl_sdk::state::listed_perpetuals(chain, provider.clone(), block_id)
        .await
        .context("discovering listed perpetuals")?;

    if let Ok(id) = market.trim().parse::<PerpetualId>() {
        if listed.contains(&id) {
            return Ok(id);
        }
        if chain.excluded_perpetuals().contains(&id) {
            bail!("perpetual {id} is excluded from indexing on this chain by the SDK");
        }
        bail!("unknown perpetual id {id}, listed: {listed:?}");
    }

    let instance = dex::Exchange::new(chain.exchange(), provider.clone());
    for id in &listed {
        let info = instance
            .getPerpetualInfoV2(U256::from(*id))
            .block(block_id)
            .call()
            .await
            .with_context(|| format!("reading perpetual {id}"))?;
        if matches_symbol(market, &[&info.symbol, &info.name]) {
            return Ok(*id);
        }
    }
    bail!("no listed perpetual matches {market:?}, listed ids: {listed:?}")
}

#[cfg(test)]
mod tests {
    use super::matches_symbol;

    #[test]
    fn symbol_matching() {
        assert!(matches_symbol("btc", &["BTC", "BTC Perp"]));
        assert!(matches_symbol("BTC", &["", "BTC Perp"]));
        assert!(matches_symbol("BTC", &["", "BTC"]));
        assert!(!matches_symbol("BTC", &["", ""]));
        assert!(!matches_symbol("ETH", &["BTC", "BTC Perp"]));
    }
}
