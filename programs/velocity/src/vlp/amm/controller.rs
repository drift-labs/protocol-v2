use anchor_lang::prelude::*;

#[cfg(test)]
use crate::math::constants::FEE_POOL_TO_REVENUE_POOL_THRESHOLD;
#[cfg(test)]
use crate::state::oracle::OraclePriceData;
#[cfg(test)]
use crate::state::perp_market::{MarketConfigFlag, PerpMarket};
use crate::{
    error::VelocityResult,
    math::{casting::Cast, quote_asset::*, safe_math::SafeMath, spot_balance::get_token_amount},
    state::{
        perp_market::AMM,
        spot_market::{SpotBalance, SpotMarket},
    },
    vlp::amm::math::{amm, amm::calculate_quote_asset_amount_swapped},
};

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwapDirection {
    Add,
    Remove,
}

fn calculate_quote_asset_amount_surplus(
    quote_asset_reserve_before: u128,
    quote_asset_reserve_after: u128,
    swap_direction: SwapDirection,
    peg_multiplier: u128,
    initial_quote_asset_amount: u128,
    round_down: bool,
) -> VelocityResult<u128> {
    let quote_asset_reserve_change = match swap_direction {
        SwapDirection::Add => quote_asset_reserve_before.safe_sub(quote_asset_reserve_after)?,

        SwapDirection::Remove => quote_asset_reserve_after.safe_sub(quote_asset_reserve_before)?,
    };

    let mut actual_quote_asset_amount =
        reserve_to_asset_amount(quote_asset_reserve_change, peg_multiplier)?;

    // Compensate for +1 quote asset amount added when removing base asset
    if round_down {
        actual_quote_asset_amount = actual_quote_asset_amount.safe_add(1)?;
    }

    let quote_asset_amount_surplus = if actual_quote_asset_amount > initial_quote_asset_amount {
        actual_quote_asset_amount.safe_sub(initial_quote_asset_amount)?
    } else {
        initial_quote_asset_amount.safe_sub(actual_quote_asset_amount)?
    };

    Ok(quote_asset_amount_surplus)
}

/// Output of an AMM swap. Named struct (not a tuple) so call sites
/// document which field is which — there's no excuse for
/// `let (_, _, q, s) = calculate_base_swap_output_with_spread(...)`.
#[derive(Debug, Clone, Copy)]
pub struct AmmSwapOutput {
    /// AMM base reserve after the swap.
    pub new_base_asset_reserve: u128,
    /// AMM quote reserve after the swap.
    pub new_quote_asset_reserve: u128,
    /// Quote amount the taker pays / receives, including the bid/ask spread.
    pub quote_asset_amount: u64,
    /// Quote profit the AMM captured from its bid/ask spread on this fill
    /// — the gap between the with-spread quote and the no-spread quote.
    /// Positive when the spread worked in the AMM's favor (always the case
    /// for normal fills; the field's `u64` type encodes that). Returned as
    /// `i64` from the higher-level `swap_base_asset` wrapper since some
    /// callers want a signed accumulator.
    pub quote_asset_amount_surplus: u64,
}

/// AMM swap math primitive. Used by [`crate::vlp::amm::AmmQuoter`] and
/// by parity tests. `pub(crate)` because no production code outside the
/// AMM/maker modules needs it — fills go through the matcher and
/// `AmmQuoter`.
///
/// Reads the spread-adjusted ask/bid reserves cached on the AMM (refreshed by
/// [`crate::vlp::amm::math::spread::update_amm_quote_state`] on each crank / fill
/// `setup`).
pub(crate) fn calculate_base_swap_output(
    amm: &AMM,
    base_asset_swap_amount: u64,
    direction: SwapDirection,
) -> VelocityResult<AmmSwapOutput> {
    // first do the swap with spread reserves to figure out how much base asset is acquired
    let (base_asset_reserve_with_spread, quote_asset_reserve_with_spread) = match direction {
        SwapDirection::Add => (amm.bid_base_asset_reserve, amm.bid_quote_asset_reserve),
        SwapDirection::Remove => (amm.ask_base_asset_reserve, amm.ask_quote_asset_reserve),
    };

    let (new_quote_asset_reserve_with_spread, _) = amm::calculate_swap_output(
        base_asset_swap_amount.cast()?,
        base_asset_reserve_with_spread,
        direction,
        amm.sqrt_k,
    )?;

    let quote_asset_amount = calculate_quote_asset_amount_swapped(
        quote_asset_reserve_with_spread,
        new_quote_asset_reserve_with_spread,
        direction,
        amm.peg_multiplier,
    )?;

    let (new_quote_asset_reserve, new_base_asset_reserve) = amm::calculate_swap_output(
        base_asset_swap_amount.cast()?,
        amm.base_asset_reserve,
        direction,
        amm.sqrt_k,
    )?;

    let quote_asset_amount_surplus = calculate_quote_asset_amount_surplus(
        new_quote_asset_reserve,
        amm.quote_asset_reserve,
        match direction {
            SwapDirection::Remove => SwapDirection::Add,
            SwapDirection::Add => SwapDirection::Remove,
        },
        amm.peg_multiplier,
        quote_asset_amount,
        direction == SwapDirection::Remove,
    )?;

    Ok(AmmSwapOutput {
        new_base_asset_reserve,
        new_quote_asset_reserve,
        quote_asset_amount: quote_asset_amount.cast::<u64>()?,
        quote_asset_amount_surplus: quote_asset_amount_surplus.cast::<u64>()?,
    })
}

// The legacy `update_spreads` / `update_spread_reserves` mutators are now a
// single [`crate::vlp::amm::math::spread::update_amm_quote_state`] that refreshes
// all the cached spread fields on the AMM in one pass. Callers that need a
// spread / spread-reserve view read the cached fields directly off the AMM.

// AMM-mutating helpers (`update_concentration_coef`, `move_price`, `recenter`)
// live as methods on `AMM` in `crate::vlp::amm::state`. Callers go through those.

/// Test-only convenience wrapper that exercises the AMM's eager k-update
/// path directly, bypassing the FundingUpdated event dispatch (which
/// would also do the AMM-as-user settle from cum-rate deltas — orthogonal
/// to what these tests cover). Production code goes through the event
/// path (see `controller/funding.rs::update_funding_rate`).
#[cfg(test)]
pub fn formulaic_update_k(
    market: &mut PerpMarket,
    oracle_price_data: &OraclePriceData,
    funding_imbalance_cost: i128,
    now: i64,
) -> VelocityResult {
    use crate::vlp::amm::AmmQuoter;

    let k_update_eligible =
        !market.has_market_config_flag(MarketConfigFlag::DisableFormulaicKUpdate);
    if !k_update_eligible {
        return Ok(());
    }
    let total_fee_floor = market.amm.protocol_floor()?;
    let market_status = market.status;
    let min_order_size = market.market_stats.min_order_size;
    let long_spread = market.amm.long_spread;
    let short_spread = market.amm.short_spread;
    let market_index = market.market_index;
    let mut amm_maker = AmmQuoter::for_amm(&mut market.amm);
    amm_maker.handle_funding_applied(
        funding_imbalance_cost,
        oracle_price_data,
        total_fee_floor,
        long_spread,
        short_spread,
        market_status,
        min_order_size,
        market_index,
        now,
    )?;
    Ok(())
}

pub fn get_fee_pool_tokens(amm: &AMM, spot_market: &SpotMarket) -> VelocityResult<i128> {
    get_token_amount(
        amm.fee_pool.balance(),
        spot_market,
        amm.fee_pool.balance_type(),
    )?
    .cast()
}

// Market-level pool accounting lives in `controller::perp_pools` — it reads
// AMM bookkeeping but the operations are protocol-level plumbing. Re-exported
// here so `use crate::vlp::amm::controller::*` star-imports still resolve them.
// Private helper re-export for `crate::vlp::amm::controller::tests`.
#[cfg(test)]
pub(crate) use crate::controller::perp_pools::calculate_revenue_pool_transfer;
pub use crate::controller::perp_pools::{update_pnl_pool_and_user_balance, update_pool_balances};
// `move_price` / `recenter` moved to `impl AMM` in `amm::state`.

// Cross-cutting AMM ↔ PerpMarket summary stat — lives in `math::perp_market`
// because it spans both. Re-exported here so star-imports still resolve.
pub use crate::math::perp_market::calculate_perp_market_amm_summary_stats;
