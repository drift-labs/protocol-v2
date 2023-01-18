use std::cmp::min;

use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::{BID_ASK_SPREAD_PRECISION_I128, TEN_BPS_I64};
use crate::math::orders::calculate_quote_asset_amount_for_maker_order;
use crate::math::safe_math::SafeMath;

use crate::state::user::Order;

#[cfg(test)]
mod tests;

#[allow(clippy::if_same_then_else)]
pub fn is_maker_for_taker(maker_order: &Order, taker_order: &Order) -> DriftResult<bool> {
    if taker_order.post_only {
        Err(ErrorCode::CantMatchTwoPostOnlys)
    } else if maker_order.post_only && !taker_order.post_only {
        Ok(true)
    } else if maker_order.is_limit_order() && taker_order.is_market_order() {
        Ok(true)
    } else if maker_order.is_market_order() {
        Ok(false)
    } else {
        Ok(maker_order.slot < taker_order.slot)
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
