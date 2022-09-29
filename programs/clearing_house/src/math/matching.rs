use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::casting::{cast_to_i128, cast_to_u128, Cast};
use crate::math::constants::{BID_ASK_SPREAD_PRECISION_I128, TEN_BPS};
use crate::math_error;
use crate::state::user::Order;
use solana_program::msg;
use std::cmp::min;

pub fn is_maker_for_taker(maker_order: &Order, taker_order: &Order) -> ClearingHouseResult<bool> {
    if taker_order.post_only {
        Err(ErrorCode::CantMatchTwoPostOnlys)
    } else if maker_order.post_only && !taker_order.post_only {
        Ok(true)
    } else {
        Ok(maker_order.ts < taker_order.ts)
    }
}

pub fn are_orders_same_market_but_different_sides(
    maker_order: &Order,
    taker_order: &Order,
) -> bool {
    maker_order.market_index == taker_order.market_index
        && maker_order.direction != taker_order.direction
}

pub fn do_orders_cross(
    maker_direction: &PositionDirection,
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
    base_precision: u32,
) -> ClearingHouseResult<(u64, u64)> {
    let base_asset_amount = min(maker_base_asset_amount, taker_base_asset_amount);

    let precision_decrease = 10_u128.pow(6 + base_precision - 6);

    let quote_asset_amount = maker_price
        .checked_mul(base_asset_amount.cast()?)
        .ok_or_else(math_error!())?
        .checked_div(precision_decrease)
        .ok_or_else(math_error!())?
        .cast::<u64>()?;

    Ok((base_asset_amount, quote_asset_amount))
}

pub fn calculate_filler_multiplier_for_matched_orders(
    maker_price: u128,
    maker_direction: &PositionDirection,
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

#[cfg(test)]
mod test {
    use super::*;

    use crate::controller::position::PositionDirection;
    use crate::math::constants::{PRICE_PRECISION, PRICE_PRECISION_I128};

    #[test]
    fn filler_multiplier_maker_long() {
        let direction = &PositionDirection::Long;
        let oracle_price = 34 * PRICE_PRECISION_I128;

        let mult = calculate_filler_multiplier_for_matched_orders(
            oracle_price as u128,
            direction,
            oracle_price,
        )
        .unwrap();
        assert_eq!(mult, 2000); // 2x

        let mult = calculate_filler_multiplier_for_matched_orders(
            (oracle_price - oracle_price / 10000) as u128, // barely bad 1 bp
            direction,
            oracle_price,
        )
        .unwrap();

        assert_eq!(mult, 1900); // 1.9x

        let maker_price_bad = 30 * PRICE_PRECISION;
        let maker_price_good = 40 * PRICE_PRECISION;

        let mult = calculate_filler_multiplier_for_matched_orders(
            maker_price_good,
            direction,
            oracle_price,
        )
        .unwrap();

        assert_eq!(mult, 100000); // 100x

        let mult = calculate_filler_multiplier_for_matched_orders(
            maker_price_bad,
            direction,
            oracle_price,
        )
        .unwrap();

        assert_eq!(mult, 1000); // 1x
    }

    #[test]
    fn filler_multiplier_maker_short() {
        let direction = &PositionDirection::Short;
        let oracle_price = 34 * PRICE_PRECISION_I128;

        let maker_price_good = 30 * PRICE_PRECISION;
        let maker_price_bad = 40 * PRICE_PRECISION;

        let mult = calculate_filler_multiplier_for_matched_orders(
            maker_price_good,
            direction,
            oracle_price,
        )
        .unwrap();

        assert_eq!(mult, 100000);

        let mult = calculate_filler_multiplier_for_matched_orders(
            maker_price_bad,
            direction,
            oracle_price,
        )
        .unwrap();

        assert_eq!(mult, 1000);

        let mult = calculate_filler_multiplier_for_matched_orders(
            (oracle_price + oracle_price / 10000) as u128, // barely bad 1 bp
            direction,
            oracle_price,
        )
        .unwrap();

        assert_eq!(mult, 1900); // 1.9x

        let mult = calculate_filler_multiplier_for_matched_orders(
            (oracle_price - oracle_price / 10000) as u128, // barely good 1 bp
            direction,
            oracle_price,
        )
        .unwrap();

        assert_eq!(mult, 2100); // 2.1x
    }
}
