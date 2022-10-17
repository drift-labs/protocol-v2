use std::cmp::min;

use solana_program::msg;

use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::casting::{cast_to_i128, cast_to_u128};
use crate::math::constants::{BID_ASK_SPREAD_PRECISION_I128, TEN_BPS};
use crate::math::orders::calculate_quote_asset_amount_for_maker_order;
use crate::math_error;
use crate::state::user::Order;

#[cfg(test)]
mod tests;

#[allow(clippy::if_same_then_else)]
pub fn is_maker_for_taker(
    maker_order: &Order,
    taker_order: &Order,
    slot: u64,
) -> ClearingHouseResult<bool> {
    if taker_order.post_only {
        Err(ErrorCode::CantMatchTwoPostOnlys)
    } else if maker_order.post_only && !taker_order.post_only {
        Ok(true)
    } else if maker_order.is_limit_order() && taker_order.is_market_order() {
        Ok(true)
    } else if !maker_order.has_limit_price(slot)? {
        Ok(false)
    } else {
        Ok(maker_order.ts < taker_order.ts)
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
    maker_price: u128,
    taker_price: u128,
) -> bool {
    match maker_direction {
        PositionDirection::Long => taker_price <= maker_price,
        PositionDirection::Short => taker_price >= maker_price,
    }
}

pub fn calculate_fill_for_matched_orders(
    maker_base_asset_amount: u64,
    maker_price: u128,
    taker_base_asset_amount: u64,
    base_decimals: u32,
    maker_direction: PositionDirection,
) -> ClearingHouseResult<(u64, u64)> {
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
    maker_price: u128,
    maker_direction: PositionDirection,
    oracle_price: i128,
) -> ClearingHouseResult<u128> {
    // percentage oracle_price is above maker_price
    let price_pct_diff = oracle_price
        .checked_sub(cast_to_i128(maker_price)?)
        .ok_or_else(math_error!())?
        .checked_mul(BID_ASK_SPREAD_PRECISION_I128)
        .ok_or_else(math_error!())?
        .checked_div(oracle_price)
        .ok_or_else(math_error!())?;

    // offer filler multiplier based on price improvement from reasonable baseline
    // multiplier between 1x and 100x
    let multiplier = match maker_direction {
        PositionDirection::Long => (-price_pct_diff)
            .checked_add(TEN_BPS * 2)
            .ok_or_else(math_error!())?,
        PositionDirection::Short => price_pct_diff
            .checked_add(TEN_BPS * 2)
            .ok_or_else(math_error!())?,
    }
    .max(TEN_BPS)
    .min(TEN_BPS * 100);

    cast_to_u128(multiplier)
}
