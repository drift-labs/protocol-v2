use crate::error::*;
use crate::math;
use crate::math_error;
use crate::state::market::Market;
use crate::state::user_orders::{Order, OrderTriggerCondition, OrderType};
use solana_program::msg;
use std::cell::RefMut;
use std::cmp::min;
use std::ops::Div;

use crate::controller::amm::SwapDirection;
use crate::controller::position::get_position_index;
use crate::controller::position::PositionDirection;
use crate::math::amm::calculate_swap_output;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128};
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO, MARGIN_PRECISION, MARK_PRICE_PRECISION,
    MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO,
};
use crate::math::margin::calculate_free_collateral;
use crate::math::quote_asset::asset_to_reserve_amount;
use crate::state::market::Markets;
use crate::state::user::{User, UserPositions};

pub fn calculate_base_asset_amount_market_can_execute(
    order: &Order,
    market: &Market,
    precomputed_mark_price: Option<u128>,
    valid_oracle_price: Option<i128>,
) -> ClearingHouseResult<u128> {
    match order.order_type {
        OrderType::Limit => {
            calculate_base_asset_amount_to_trade_for_limit(order, market, valid_oracle_price)
        }
        OrderType::TriggerMarket => calculate_base_asset_amount_to_trade_for_trigger_market(
            order,
            market,
            precomputed_mark_price,
            valid_oracle_price,
        ),
        OrderType::TriggerLimit => calculate_base_asset_amount_to_trade_for_trigger_limit(
            order,
            market,
            precomputed_mark_price,
            valid_oracle_price,
        ),
        OrderType::Market => Err(ErrorCode::InvalidOrder),
    }
}

pub fn calculate_base_asset_amount_to_trade_for_limit(
    order: &Order,
    market: &Market,
    valid_oracle_price: Option<i128>,
) -> ClearingHouseResult<u128> {
    let base_asset_amount_to_fill = order
        .base_asset_amount
        .checked_sub(order.base_asset_amount_filled)
        .ok_or_else(math_error!())?;

    let limit_price = order.get_limit_price(valid_oracle_price)?;

    let (max_trade_base_asset_amount, max_trade_direction) =
        math::amm::calculate_max_base_asset_amount_to_trade(&market.amm, limit_price)?;
    if max_trade_direction != order.direction || max_trade_base_asset_amount == 0 {
        return Ok(0);
    }

    let base_asset_amount_to_trade = min(base_asset_amount_to_fill, max_trade_base_asset_amount);

    Ok(base_asset_amount_to_trade)
}

fn calculate_base_asset_amount_to_trade_for_trigger_market(
    order: &Order,
    market: &Market,
    precomputed_mark_price: Option<u128>,
    valid_oracle_price: Option<i128>,
) -> ClearingHouseResult<u128> {
    let mark_price = match precomputed_mark_price {
        Some(mark_price) => mark_price,
        None => market.amm.mark_price()?,
    };

    match order.trigger_condition {
        OrderTriggerCondition::Above => {
            if mark_price <= order.trigger_price {
                return Ok(0);
            }

            // If there is a valid oracle, check that trigger condition is also satisfied by
            // oracle price (plus some additional buffer)
            if let Some(oracle_price) = valid_oracle_price {
                let oracle_price_101pct = oracle_price
                    .checked_mul(101)
                    .ok_or_else(math_error!())?
                    .checked_div(100)
                    .ok_or_else(math_error!())?;

                if cast_to_u128(oracle_price_101pct)? <= order.trigger_price {
                    return Ok(0);
                }
            }
        }
        OrderTriggerCondition::Below => {
            if mark_price >= order.trigger_price {
                return Ok(0);
            }

            // If there is a valid oracle, check that trigger condition is also satisfied by
            // oracle price (plus some additional buffer)
            if let Some(oracle_price) = valid_oracle_price {
                let oracle_price_99pct = oracle_price
                    .checked_mul(99)
                    .ok_or_else(math_error!())?
                    .checked_div(100)
                    .ok_or_else(math_error!())?;

                if cast_to_u128(oracle_price_99pct)? >= order.trigger_price {
                    return Ok(0);
                }
            }
        }
    }

    order
        .base_asset_amount
        .checked_sub(order.base_asset_amount_filled)
        .ok_or_else(math_error!())
}

fn calculate_base_asset_amount_to_trade_for_trigger_limit(
    order: &Order,
    market: &Market,
    precomputed_mark_price: Option<u128>,
    valid_oracle_price: Option<i128>,
) -> ClearingHouseResult<u128> {
    // if the order has not been filled yet, need to check that trigger condition is met
    if order.base_asset_amount_filled == 0 {
        let base_asset_amount = calculate_base_asset_amount_to_trade_for_trigger_market(
            order,
            market,
            precomputed_mark_price,
            valid_oracle_price,
        )?;
        if base_asset_amount == 0 {
            return Ok(0);
        }
    }

    calculate_base_asset_amount_to_trade_for_limit(order, market, None)
}

pub fn calculate_base_asset_amount_user_can_execute(
    user: &mut User,
    user_positions: &mut RefMut<UserPositions>,
    order: &mut Order,
    markets: &mut RefMut<Markets>,
    market_index: u64,
) -> ClearingHouseResult<u128> {
    let position_index = get_position_index(user_positions, market_index)?;

    let quote_asset_amount = calculate_available_quote_asset_user_can_execute(
        user,
        order,
        position_index,
        user_positions,
        markets,
    )?;

    let market = markets.get_market_mut(market_index);

    let order_swap_direction = match order.direction {
        PositionDirection::Long => SwapDirection::Add,
        PositionDirection::Short => SwapDirection::Remove,
    };

    // Extra check in case user have more collateral than market has reserves
    let quote_asset_reserve_amount = min(
        market
            .amm
            .quote_asset_reserve
            .checked_sub(1)
            .ok_or_else(math_error!())?,
        asset_to_reserve_amount(quote_asset_amount, market.amm.peg_multiplier)?,
    );

    let initial_base_asset_amount = market.amm.base_asset_reserve;
    let (new_base_asset_amount, _new_quote_asset_amount) = calculate_swap_output(
        quote_asset_reserve_amount,
        market.amm.quote_asset_reserve,
        order_swap_direction,
        market.amm.sqrt_k,
    )?;

    let base_asset_amount = cast_to_i128(initial_base_asset_amount)?
        .checked_sub(cast(new_base_asset_amount)?)
        .ok_or_else(math_error!())?
        .unsigned_abs();

    Ok(base_asset_amount)
}

pub fn calculate_available_quote_asset_user_can_execute(
    user: &User,
    order: &Order,
    position_index: usize,
    user_positions: &mut UserPositions,
    markets: &Markets,
) -> ClearingHouseResult<u128> {
    let market_position = &user_positions.positions[position_index];
    let market = markets.get_market(market_position.market_index);
    let max_leverage = MARGIN_PRECISION
        .checked_div(
            // add one to initial margin ratio so we don't fill exactly to max leverage
            cast_to_u128(market.margin_ratio_initial)?
                .checked_add(1)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    let risk_increasing_in_same_direction = market_position.base_asset_amount == 0
        || market_position.base_asset_amount > 0 && order.direction == PositionDirection::Long
        || market_position.base_asset_amount < 0 && order.direction == PositionDirection::Short;

    let available_quote_asset_for_order = if risk_increasing_in_same_direction {
        let (free_collateral, _) = calculate_free_collateral(user, user_positions, markets, None)?;

        free_collateral
            .checked_mul(max_leverage)
            .ok_or_else(math_error!())?
    } else {
        let market_index = market_position.market_index;
        let (free_collateral, closed_position_base_asset_value) =
            calculate_free_collateral(user, user_positions, markets, Some(market_index))?;

        free_collateral
            .checked_mul(max_leverage)
            .ok_or_else(math_error!())?
            .checked_add(closed_position_base_asset_value)
            .ok_or_else(math_error!())?
    };

    Ok(available_quote_asset_for_order)
}

pub fn limit_price_satisfied(
    limit_price: u128,
    quote_asset_amount: u128,
    base_asset_amount: u128,
    direction: PositionDirection,
) -> ClearingHouseResult<bool> {
    let price = quote_asset_amount
        .checked_mul(MARK_PRICE_PRECISION * AMM_TO_QUOTE_PRECISION_RATIO)
        .ok_or_else(math_error!())?
        .div(base_asset_amount);

    match direction {
        PositionDirection::Long => {
            if price > limit_price {
                return Ok(false);
            }
        }
        PositionDirection::Short => {
            if price < limit_price {
                return Ok(false);
            }
        }
    }

    Ok(true)
}

pub fn calculate_quote_asset_amount_for_maker_order(
    base_asset_amount: u128,
    limit_price: u128,
) -> ClearingHouseResult<u128> {
    Ok(base_asset_amount
        .checked_mul(limit_price)
        .ok_or_else(math_error!())?
        .div(MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO))
}
