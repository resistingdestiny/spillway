//! Aggregates the SDK's L3 order book (every resting order) into price levels.

use std::{cmp::Reverse, collections::BTreeMap};

use fastnum::UD64;
use perpl_sdk::{state::OrderBook, types::OrderSide};

/// One price level: total live size and the number of live orders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Level {
    pub price: UD64,
    pub size: UD64,
    pub orders: u32,
}

#[derive(Debug, Default)]
pub struct Levels {
    /// Best (highest) bid first.
    pub bids: Vec<Level>,
    /// Best (lowest) ask first.
    pub asks: Vec<Level>,
    /// Orders still in the contract's book but past their expiry block. The
    /// exchange will not fill them, so they are left out of the levels.
    pub expired_orders: usize,
    /// Levels where this aggregation disagrees with the SDK's own cached L2
    /// view. Expected to be zero.
    pub l2_mismatches: usize,
}

impl Levels {
    pub fn best_bid(&self) -> Option<UD64> { self.bids.first().map(|l| l.price) }

    pub fn best_ask(&self) -> Option<UD64> { self.asks.first().map(|l| l.price) }
}

/// Walks every L3 order, skips expired ones and sums size and count per price.
/// Then checks the result against the SDK's cached L2 levels.
pub fn aggregate(book: &OrderBook) -> Levels {
    let mut bids: BTreeMap<Reverse<UD64>, (UD64, u32)> = BTreeMap::new();
    let mut asks: BTreeMap<UD64, (UD64, u32)> = BTreeMap::new();
    let mut expired_orders = 0;

    for order in book.all_orders().values() {
        if order.is_expired() {
            expired_orders += 1;
            continue;
        }
        let entry = match order.r#type().side() {
            OrderSide::Bid => bids.entry(Reverse(order.price())).or_default(),
            OrderSide::Ask => asks.entry(order.price()).or_default(),
        };
        entry.0 += order.size();
        entry.1 += 1;
    }

    let level = |price: UD64, (size, orders): (UD64, u32)| Level { price, size, orders };
    let bids: Vec<Level> = bids.into_iter().map(|(p, v)| level(p.0, v)).collect();
    let asks: Vec<Level> = asks.into_iter().map(|(p, v)| level(p, v)).collect();

    // The SDK keeps an L2 view with cached totals per level. Levels whose
    // orders have all expired stay in it with zero size, so skip those.
    let sdk_bids: Vec<Level> = book
        .bids()
        .iter()
        .filter(|(_, l)| l.size() > UD64::ZERO)
        .map(|(p, l)| level(p.0, (l.size(), l.num_orders())))
        .collect();
    let sdk_asks: Vec<Level> = book
        .asks()
        .iter()
        .filter(|(_, l)| l.size() > UD64::ZERO)
        .map(|(p, l)| level(*p, (l.size(), l.num_orders())))
        .collect();
    let l2_mismatches = count_mismatches(&bids, &sdk_bids) + count_mismatches(&asks, &sdk_asks);

    Levels { bids, asks, expired_orders, l2_mismatches }
}

fn count_mismatches(ours: &[Level], sdk: &[Level]) -> usize {
    let differing = ours.iter().zip(sdk).filter(|(a, b)| a != b).count();
    differing + ours.len().abs_diff(sdk.len())
}
