//! Consistency checks and a short human summary, printed to stderr.

use fastnum::UD128;

use crate::{book::Levels, schema::Snapshot};

/// Open interest check for one side: the sum of position sizes against the
/// contract's own open interest counter.
#[derive(Debug, Clone, Copy)]
pub struct OiCheck {
    pub positions: usize,
    pub sum_sizes: UD128,
    pub open_interest: UD128,
}

impl OiCheck {
    pub fn ok(&self) -> bool {
        self.sum_sizes == self.open_interest
    }

    fn line(&self, side: &str) -> String {
        format!(
            "{side:<5} {:>4} positions, sum of sizes {} vs open interest {}: {}",
            self.positions,
            self.sum_sizes,
            self.open_interest,
            if self.ok() { "OK" } else { "MISMATCH" }
        )
    }
}

pub struct Checks {
    pub long: OiCheck,
    pub short: OiCheck,
    pub mark_age_secs: i64,
    pub oracle_age_secs: i64,
}

/// Dollar value of resting bids priced within `pct` of `mid`.
pub fn bid_depth(snapshot: &Snapshot, mid: f64, pct: f64) -> f64 {
    let floor = mid * (1.0 - pct);
    snapshot
        .book
        .bids
        .iter()
        .filter(|(price, _, _)| *price >= floor)
        .map(|(price, size, _)| price * size)
        .sum()
}

/// Dollar value of resting asks priced within `pct` of `mid`.
pub fn ask_depth(snapshot: &Snapshot, mid: f64, pct: f64) -> f64 {
    let cap = mid * (1.0 + pct);
    snapshot
        .book
        .asks
        .iter()
        .filter(|(price, _, _)| *price <= cap)
        .map(|(price, size, _)| price * size)
        .sum()
}

pub fn print(snapshot: &Snapshot, levels: &Levels, checks: &Checks) {
    let m = &snapshot.market;
    let mark = m.mark_price;
    let mut out = Vec::new();

    out.push(format!(
        "{} {} (perp {}) at block {} ({}), contract {}",
        snapshot.network,
        m.symbol,
        m.perp_id,
        snapshot.block,
        snapshot.block_timestamp,
        snapshot
            .source
            .contract_version
            .as_deref()
            .unwrap_or("unknown"),
    ));
    out.push(format!(
        "mark {} (age {}s), oracle {} (age {}s), last {}",
        m.mark_price, checks.mark_age_secs, m.oracle_price, checks.oracle_age_secs, m.last_price
    ));
    out.push(format!(
        "insurance fund ${:.2}, position balance ${:.2}, liquidation split trader/insurance/protocol {}/{}/{}, fee share to insurance {}",
        m.insurance_fund,
        m.position_balance,
        m.liquidation_split.trader,
        m.liquidation_split.insurance,
        m.liquidation_split.protocol,
        m.fee_insurance_share
    ));
    out.push(format!(
        "margins: maintenance {:.4} initial {:.4}, fees taker {} maker {}, funding rate {}",
        m.maintenance_margin_fraction,
        m.initial_margin_fraction,
        m.taker_fee,
        m.maker_fee,
        m.funding_rate
    ));

    // Positions
    out.push(format!("positions: {}", snapshot.positions.len()));
    out.push(format!("  {}", checks.long.line("long")));
    out.push(format!("  {}", checks.short.line("short")));

    let mut leverage_mark: Vec<f64> = Vec::new();
    let mut leverage_entry: Vec<f64> = Vec::new();
    let (mut past_liq, mut past_bankrupt) = (0usize, 0usize);
    let mut worst_pnl_gap: f64 = 0.0;
    for p in &snapshot.positions {
        let long = p.side == "long";
        let equity = p.deposit + p.delta_pnl + p.premium_pnl;
        if equity > 0.0 {
            leverage_mark.push(p.size * mark / equity);
        }
        if p.deposit > 0.0 {
            leverage_entry.push(p.size * p.entry_price / p.deposit);
        }
        if (long && mark <= p.liquidation_price) || (!long && mark >= p.liquidation_price) {
            past_liq += 1;
        }
        if (long && mark <= p.bankruptcy_price) || (!long && mark >= p.bankruptcy_price) {
            past_bankrupt += 1;
        }
        // deltaPnl is read from the contract; compare with mark-to-market.
        let side = if long { 1.0 } else { -1.0 };
        let mtm = side * (mark - p.entry_price) * p.size;
        worst_pnl_gap = worst_pnl_gap.max((p.delta_pnl - mtm).abs());
    }
    let range = |v: &mut Vec<f64>| {
        v.sort_by(f64::total_cmp);
        match (v.first(), v.last()) {
            (Some(lo), Some(hi)) => format!("{lo:.2}x to {hi:.2}x (median {:.2}x)", v[v.len() / 2]),
            _ => "n/a".to_string(),
        }
    };
    out.push(format!(
        "  leverage at mark (notional / equity): {}",
        range(&mut leverage_mark)
    ));
    out.push(format!(
        "  leverage at entry (notional / deposit): {}",
        range(&mut leverage_entry)
    ));
    out.push(format!(
        "  at mark: {past_liq} past liquidation price, {past_bankrupt} past bankruptcy price"
    ));
    out.push(format!(
        "  largest gap between deltaPnl and (mark - entry) * size: ${worst_pnl_gap:.2}"
    ));

    // Book
    out.push(format!(
        "book: {} bid levels, {} ask levels, {} expired orders left out, {} L2 mismatches",
        snapshot.book.bids.len(),
        snapshot.book.asks.len(),
        levels.expired_orders,
        levels.l2_mismatches
    ));
    let best_bid = snapshot.book.bids.first().map(|l| l.0);
    let best_ask = snapshot.book.asks.first().map(|l| l.0);
    match (best_bid, best_ask) {
        (Some(bid), Some(ask)) => {
            let mid = (bid + ask) / 2.0;
            out.push(format!(
                "  best bid {bid} / best ask {ask}, spread {:.2} bps, mid {mid}",
                (ask - bid) / mid * 1e4
            ));
            for pct in [0.01, 0.05, 0.10] {
                out.push(format!(
                    "  depth within {:>2.0}% of mid: bids ${:.0}, asks ${:.0}",
                    pct * 100.0,
                    bid_depth(snapshot, mid, pct),
                    ask_depth(snapshot, mid, pct)
                ));
            }
        }
        _ => out.push(format!(
            "  best bid {best_bid:?} / best ask {best_ask:?}: one side is empty"
        )),
    }

    for note in &snapshot.source.notes {
        out.push(format!("note: {note}"));
    }
    eprintln!("{}", out.join("\n"));
}
