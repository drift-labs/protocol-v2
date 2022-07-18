use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::constants::MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO;
use crate::math_error;
use crate::state::user::{Order, User};
use anchor_lang::prelude::Pubkey;
use solana_program::msg;
use std::cmp::min;

pub fn determine_maker_and_taker<'a>(
    first_user: &'a mut User,
    first_user_order_index: usize,
    first_user_key: &'a Pubkey,
    second_user: &'a mut User,
    second_user_order_index: usize,
    second_user_key: &'a Pubkey,
) -> ClearingHouseResult<(
    &'a mut User,
    usize,
    &'a Pubkey,
    &'a mut User,
    usize,
    &'a Pubkey,
)> {
    let first_order = &first_user.orders[first_user_order_index];
    let second_order = &second_user.orders[second_user_order_index];

    if first_order.post_only && second_order.post_only {
        return Err(ErrorCode::CantMatchTwoPostOnlys);
    }

    if first_order.post_only == second_order.post_only {
        if first_order.ts >= second_order.ts {
            Ok((
                first_user,
                first_user_order_index,
                first_user_key,
                second_user,
                second_user_order_index,
                second_user_key,
            ))
        } else {
            Ok((
                second_user,
                second_user_order_index,
                second_user_key,
                first_user,
                first_user_order_index,
                first_user_key,
            ))
        }
    } else if second_order.post_only {
        Ok((
            first_user,
            first_user_order_index,
            first_user_key,
            second_user,
            second_user_order_index,
            second_user_key,
        ))
    } else {
        Ok((
            second_user,
            second_user_order_index,
            second_user_key,
            first_user,
            first_user_order_index,
            first_user_key,
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
) -> ClearingHouseResult<(u128, u128)> {
    let base_asset_amount = min(maker_base_asset_amount, taker_base_asset_amount);

    let quote_asset_amount = base_asset_amount
        .checked_mul(maker_price)
        .ok_or_else(math_error!())?
        .checked_div(MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO)
        .ok_or_else(math_error!())?;

    Ok((base_asset_amount, quote_asset_amount))
}
