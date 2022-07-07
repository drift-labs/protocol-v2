use crate::controller::position::PositionDirection;
use crate::error::ClearingHouseResult;
use crate::math::constants::MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO;
use crate::math_error;
use crate::state::user::{Order, User};
use solana_program::msg;
use std::cmp::min;

pub fn determine_maker_and_taker<'a>(
    first_user: &'a mut User,
    first_user_order_index: usize,
    second_user: &'a mut User,
    second_user_order_index: usize,
) -> ClearingHouseResult<(&'a mut User, usize, &'a mut User, usize)> {
    let first_order = &first_user.orders[first_user_order_index];
    let second_order = &second_user.orders[second_user_order_index];

    if first_order.post_only == second_order.post_only {
        if first_order.ts >= second_order.ts {
            Ok((
                first_user,
                first_user_order_index,
                second_user,
                second_user_order_index,
            ))
        } else {
            Ok((
                second_user,
                second_user_order_index,
                first_user,
                first_user_order_index,
            ))
        }
    } else if second_order.post_only {
        Ok((
            first_user,
            first_user_order_index,
            second_user,
            second_user_order_index,
        ))
    } else {
        Ok((
            second_user,
            second_user_order_index,
            first_user,
            first_user_order_index,
        ))
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
    maker_base_asset_amount: u128,
    maker_price: u128,
    taker_base_asset_amount: u128,
    taker_price: u128,
    taker_post_only: bool,
) -> ClearingHouseResult<(u128, u128, u128, u128)> {
    let base_asset_amount = min(maker_base_asset_amount, taker_base_asset_amount);

    let maker_quote_asset_amount = base_asset_amount
        .checked_mul(maker_price)
        .ok_or_else(math_error!())?
        .checked_div(MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO)
        .ok_or_else(math_error!())?;

    let (taker_quote_asset_amount, quote_asset_amount_surplus) = if taker_post_only {
        let taker_quote_asset_amount = base_asset_amount
            .checked_mul(taker_price)
            .ok_or_else(math_error!())?
            .checked_div(MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO)
            .ok_or_else(math_error!())?;

        let quote_asset_amount_surplus = if taker_quote_asset_amount > maker_quote_asset_amount {
            taker_quote_asset_amount
                .checked_sub(maker_quote_asset_amount)
                .ok_or_else(math_error!())?
        } else {
            maker_quote_asset_amount
                .checked_sub(taker_quote_asset_amount)
                .ok_or_else(math_error!())?
        };

        (taker_quote_asset_amount, quote_asset_amount_surplus)
    } else {
        (maker_quote_asset_amount, 0)
    };

    Ok((
        base_asset_amount,
        maker_quote_asset_amount,
        taker_quote_asset_amount,
        quote_asset_amount_surplus,
    ))
}
