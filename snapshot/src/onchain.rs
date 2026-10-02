//! Reads the SDK's `Perpetual` does not expose: the insurance fund, the
//! position balance, open interest per side and the liquidation split.
//!
//! These come straight from the SDK's generated `Exchange` binding, batched in
//! one multicall pinned to the snapshot block so they match the SDK snapshot.

use alloy::{eips::BlockId, primitives::U256, providers::Provider};
use anyhow::Context;
use fastnum::{UD64, UD128};
use perpl_sdk::{Chain, abi::dex, num, types::PerpetualId};

/// Contract rates in hundred-thousandths (`Per100K`).
const PER_100K: u8 = 5;

#[derive(Debug, Clone, Copy)]
pub struct MarketExtras {
    pub insurance_fund: UD128,
    pub position_balance: UD128,
    pub long_open_interest: UD128,
    pub short_open_interest: UD128,
    pub liq_trader: UD64,
    pub liq_insurance: UD64,
    pub liq_protocol: UD64,
    pub fee_insurance_share: UD64,
}

pub async fn read<P: Provider + Clone>(
    chain: &Chain,
    provider: &P,
    block: u64,
    perp_id: PerpetualId,
    collateral: num::Converter,
    size: num::Converter,
) -> anyhow::Result<MarketExtras> {
    let instance = dex::Exchange::new(chain.exchange(), provider.clone());
    let pid = U256::from(perp_id);
    let (info, liq, split) = provider
        .multicall()
        .block(BlockId::number(block))
        .add(instance.getPerpetualInfoV2(pid))
        .add(instance.getLiquidationInfo(pid))
        .add(instance.getInsuranceProtocolSplit(pid))
        .aggregate()
        .await
        .context("reading insurance fund and liquidation split")?;

    let rate = num::Converter::new(PER_100K);
    Ok(MarketExtras {
        insurance_fund: collateral.from_unsigned(info.insuranceBalanceCNS),
        position_balance: collateral.from_unsigned(info.positionBalanceCNS),
        long_open_interest: size.from_unsigned(info.longOpenInterestLNS),
        short_open_interest: size.from_unsigned(info.shortOpenInterestLNS),
        liq_trader: rate.from_unsigned(liq.liqUserAmtPer100K),
        liq_insurance: rate.from_unsigned(liq.liqInsAmtPer100K),
        liq_protocol: rate.from_unsigned(liq.liqProtocolAmtPer100K),
        fee_insurance_share: rate.from_unsigned(split.insAmtPer100K),
    })
}
