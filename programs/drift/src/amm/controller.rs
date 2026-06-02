use anchor_lang::prelude::*;

use crate::amm::math::amm;
use crate::amm::math::amm::calculate_quote_asset_amount_swapped;
use crate::amm::math::spread::AmmQuoteState;
use crate::error::DriftResult;
use crate::math::casting::Cast;
use crate::math::quote_asset::*;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;

use crate::state::perp_market::AMM;
use crate::state::spot_market::{SpotBalance, SpotMarket};

#[cfg(test)]
use crate::math::constants::FEE_POOL_TO_REVENUE_POOL_THRESHOLD;
#[cfg(test)]
use crate::state::oracle::OraclePriceData;
#[cfg(test)]
use crate::state::perp_market::{MarketConfigFlag, PerpMarket};

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
) -> DriftResult<u128> {
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

/// AMM swap math primitive. Used by [`crate::amm::AmmQuoter`] and
/// by parity tests. `pub(crate)` because no production code outside the
/// AMM/maker modules needs it — fills go through the matcher and
/// `AmmQuoter`.
///
/// Takes an explicit [`AmmQuoteState`] (spread + spread reserves) rather
/// than reading from the AMM struct: those fields were removed in the
/// AMM-decoupling refactor. Callers materialise the quote state via
/// [`crate::amm::math::spread::compute_amm_quote_state`].
pub(crate) fn calculate_base_swap_output_with_quote_state(
    amm: &AMM,
    quote_state: &AmmQuoteState,
    base_asset_swap_amount: u64,
    direction: SwapDirection,
) -> DriftResult<AmmSwapOutput> {
    // first do the swap with spread reserves to figure out how much base asset is acquired
    let (base_asset_reserve_with_spread, quote_asset_reserve_with_spread) = match direction {
        SwapDirection::Add => (
            quote_state.bid_base_asset_reserve,
            quote_state.bid_quote_asset_reserve,
        ),
        SwapDirection::Remove => (
            quote_state.ask_base_asset_reserve,
            quote_state.ask_quote_asset_reserve,
        ),
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

// `update_spreads` and `update_spread_reserves` have been removed: those
// mutators wrote into cached AMM fields (`long_spread`, `short_spread`,
// `reference_price_offset`, `ask/bid_*_asset_reserve`,
// `last_oracle_reserve_price_spread_pct`) which no longer exist. Callers
// that need a spread / spread-reserve view of the AMM materialise an
// [`crate::amm::math::spread::AmmQuoteState`] on demand via
// [`crate::amm::math::spread::compute_amm_quote_state`].

// AMM-mutating helpers (`update_concentration_coef`, `move_price`, `recenter`)
// live as methods on `AMM` in `crate::amm::state`. Callers go through those.

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
    _now: i64,
    amm_quote_state: &AmmQuoteState,
) -> DriftResult {
    use crate::amm::AmmQuoter;
    use crate::state::quoter::QuoteContext;

    let k_update_eligible =
        !market.has_market_config_flag(MarketConfigFlag::DisableFormulaicKUpdate);
    if !k_update_eligible {
        return Ok(());
    }
    let total_fee_floor = market
        .amm
        .protocol_floor(market.total_exchange_fee, market.total_liquidation_fee)?;
    let market_status = market.status;
    let min_order_size = market.market_stats.min_order_size;
    let stats_snapshot = market.market_stats;
    let ctx = QuoteContext {
        stats: &stats_snapshot,
        oracle: oracle_price_data,
        mm_oracle: None,
        oracle_validity: None,
        fee_budget: 0,
        tick: market.order_tick_size,
        step_size: market.order_step_size,
        slot: 0,
        base_precision: crate::math::constants::BASE_PRECISION_U64,
        total_exchange_fee: 0,
        total_liquidation_fee: 0,
        market_status: crate::state::market_status::MarketStatus::default(),
        market_config: 0,
    };
    let long_spread = amm_quote_state.long_spread;
    let short_spread = amm_quote_state.short_spread;
    let market_index = market.market_index;
    let mut amm_maker = AmmQuoter::for_amm(&mut market.amm);
    amm_maker.handle_funding_applied(
        &ctx,
        funding_imbalance_cost,
        oracle_price_data,
        total_fee_floor,
        long_spread,
        short_spread,
        market_status,
        min_order_size,
        market_index,
        _now,
    )?;
    Ok(())
}

pub fn get_fee_pool_tokens(amm: &AMM, spot_market: &SpotMarket) -> DriftResult<i128> {
    get_token_amount(
        amm.fee_pool.balance(),
        spot_market,
        amm.fee_pool.balance_type(),
    )?
    .cast()
}

// Market-level pool accounting lives in `controller::perp_pools` — it reads
// AMM bookkeeping but the operations are protocol-level plumbing. Re-exported
// here so `use crate::amm::controller::*` star-imports still resolve them.
pub use crate::controller::perp_pools::{update_pnl_pool_and_user_balance, update_pool_balances};

// Private helper re-export for `crate::amm::controller::tests`.
#[cfg(test)]
pub(crate) use crate::controller::perp_pools::calculate_revenue_pool_transfer;

// `move_price` / `recenter` moved to `impl AMM` in `amm::state`.

// Cross-cutting AMM ↔ PerpMarket summary stat — lives in `math::perp_market`
// because it spans both. Re-exported here so star-imports still resolve.
pub use crate::math::perp_market::calculate_perp_market_amm_summary_stats;
