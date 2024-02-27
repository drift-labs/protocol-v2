use std::cmp::min;

use crate::controller::position::PositionDirection;
use crate::error::DriftResult;
use crate::math::casting::Cast;
use crate::math::constants::{BID_ASK_SPREAD_PRECISION_I128, TEN_BPS_I64};
use crate::math::orders::calculate_quote_asset_amount_for_maker_order;
use crate::math::safe_math::SafeMath;

use crate::state::user::Order;

#[cfg(test)]
mod tests;

pub fn is_maker_for_taker(
    maker_order: &Order,
    taker_order: &Order,
    slot: u64,
) -> DriftResult<bool> {
    // Maker and taker order not allowed to match if both were placed in the current slot
    if slot == maker_order.slot && slot == taker_order.slot {
        return Ok(false);
    };

    // taker cant be post only and maker must be resting limit order
    if taker_order.post_only || !maker_order.is_resting_limit_order(slot)? {
        Ok(false)
    // can make if taker order isn't resting (market order or limit going through auction)
    } else if !taker_order.is_resting_limit_order(slot)? || maker_order.post_only {
        Ok(true)
    // otherwise the maker must be older than the taker order
    } else {
        Ok(maker_order
            .slot
            .safe_add(maker_order.auction_duration.cast()?)?
            <= taker_order
                .slot
                .safe_add(taker_order.auction_duration.cast()?)?)
    }
}

pub fn are_orders_same_market_but_different_sides(
    maker_order: &Order,
    taker_order: &Order,
) -> bool {
    maker_order.market_index == taker_order.market_index
        && maker_order.market_type == taker_order.market_type
        && maker_order.direction != taker_order.direction
}

pub fn do_orders_cross(
    maker_direction: PositionDirection,
    maker_price: u64,
    taker_price: u64,
) -> bool {
    match maker_direction {
        PositionDirection::Long => taker_price <= maker_price,
        PositionDirection::Short => taker_price >= maker_price,
    }
}

pub fn calculate_fill_for_matched_orders(
    maker_base_asset_amount: u64,
    maker_price: u64,
    taker_base_asset_amount: u64,
    base_decimals: u32,
    maker_direction: PositionDirection,
) -> DriftResult<(u64, u64)> {
    let base_asset_amount = min(maker_base_asset_amount, taker_base_asset_amount);

    let quote_asset_amount = calculate_quote_asset_amount_for_maker_order(
        base_asset_amount,
        maker_price,
        base_decimals,
        maker_direction,
    )?;

    Ok((base_asset_amount, quote_asset_amount))
}

pub fn calculate_filler_multiplier_for_matched_orders(
    maker_price: u64,
    maker_direction: PositionDirection,
    oracle_price: i64,
) -> DriftResult<u64> {
    // percentage oracle_price is above maker_price
    let price_pct_diff = oracle_price
        .safe_sub(maker_price.cast::<i64>()?)?
        .cast::<i128>()?
        .safe_mul(BID_ASK_SPREAD_PRECISION_I128)?
        .safe_div(oracle_price.cast()?)?
        .cast::<i64>()?;

    // offer filler multiplier based on price improvement from reasonable baseline
    // multiplier between 1x and 100x
    let multiplier = match maker_direction {
        PositionDirection::Long => (-price_pct_diff).safe_add(TEN_BPS_I64 * 2)?,
        PositionDirection::Short => price_pct_diff.safe_add(TEN_BPS_I64 * 2)?,
    }
    .max(TEN_BPS_I64)
    .min(TEN_BPS_I64 * 100);

    multiplier.cast()
}
