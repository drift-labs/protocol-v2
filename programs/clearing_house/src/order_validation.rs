use std::ops::Div;

use solana_program::msg;

use crate::context::OrderParams;
use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::constants::*;
use crate::math::margin::meets_initial_margin_requirement;
use crate::math::orders::calculate_base_asset_amount_to_trade_for_limit;
use crate::math::quote_asset::asset_to_reserve_amount;
use crate::state::bank_map::BankMap;
use crate::state::market::Market;
use crate::state::market_map::MarketMap;
use crate::state::oracle_map::OracleMap;
use crate::state::state::State;
use crate::state::user::{MarketPosition, Order, OrderTriggerCondition, OrderType, User};

pub fn validate_order(
    order: &Order,
    market: &Market,
    state: &State,
    valid_oracle_price: Option<i128>,
    now: i64,
) -> ClearingHouseResult {
    match order.order_type {
        OrderType::Market => validate_market_order(order, market)?,
        OrderType::Limit => validate_limit_order(order, market, state, valid_oracle_price, now)?,
        OrderType::TriggerMarket => validate_trigger_market_order(order, market, state)?,
        OrderType::TriggerLimit => validate_trigger_limit_order(order, market, state)?,
    }

    Ok(())
}

fn validate_market_order(order: &Order, market: &Market) -> ClearingHouseResult {
    if order.quote_asset_amount > 0 && order.base_asset_amount > 0 {
        msg!("Market order should not have quote_asset_amount and base_asset_amount set");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.base_asset_amount > 0 {
        validate_base_asset_amount(order, market)?;
    } else {
        validate_quote_asset_amount(order, market)?;
    }

    if order.trigger_price > 0 {
        msg!("Market should not have trigger price");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.post_only {
        msg!("Market order can not be post only");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.has_oracle_price_offset() {
        msg!("Market order can not have oracle offset");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.immediate_or_cancel {
        msg!("Market order can not be immediate or cancel");
        return Err(ErrorCode::InvalidOrder);
    }

    Ok(())
}

fn validate_limit_order(
    order: &Order,
    market: &Market,
    state: &State,
    valid_oracle_price: Option<i128>,
    now: i64,
) -> ClearingHouseResult {
    validate_base_asset_amount(order, market)?;

    if order.price == 0 && !order.has_oracle_price_offset() {
        msg!("Limit order price == 0");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.has_oracle_price_offset() {
        if order.post_only && order.price == 0 {
            msg!("Limit order price must not be 0 for post only oracle offset order");
            return Err(ErrorCode::InvalidOrder);
        } else if !order.post_only && order.price != 0 {
            msg!("Limit order price must be 0 for taker oracle offset order");
            return Err(ErrorCode::InvalidOrder);
        }
    }

    if order.trigger_price > 0 {
        msg!("Limit order should not have trigger price");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.quote_asset_amount != 0 {
        msg!("Limit order should not have a quote asset amount");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.post_only {
        validate_post_only_order(order, market, valid_oracle_price, now)?;
    }

    let limit_price = order.get_limit_price(valid_oracle_price, now)?;
    let approximate_market_value = limit_price
        .checked_mul(order.base_asset_amount)
        .unwrap_or(u128::MAX)
        .div(AMM_RESERVE_PRECISION)
        .div(MARK_PRICE_PRECISION / QUOTE_PRECISION);

    if approximate_market_value < state.min_order_quote_asset_amount {
        msg!("Order value < $0.50 ({:?})", approximate_market_value);
        return Err(ErrorCode::InvalidOrder);
    }

    Ok(())
}

fn validate_post_only_order(
    order: &Order,
    market: &Market,
    valid_oracle_price: Option<i128>,
    now: i64,
) -> ClearingHouseResult {
    let base_asset_amount_market_can_fill =
        calculate_base_asset_amount_to_trade_for_limit(order, market, valid_oracle_price, now)?;

    if base_asset_amount_market_can_fill != 0 {
        msg!(
            "Post-only order can immediately fill {} base asset amount",
            base_asset_amount_market_can_fill
        );
        return Err(ErrorCode::InvalidOrder);
    }

    Ok(())
}

fn validate_trigger_limit_order(
    order: &Order,
    market: &Market,
    state: &State,
) -> ClearingHouseResult {
    validate_base_asset_amount(order, market)?;

    if order.price == 0 {
        msg!("Trigger limit order price == 0");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.trigger_price == 0 {
        msg!("Trigger price == 0");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.quote_asset_amount != 0 {
        msg!("Trigger limit order should not have a quote asset amount");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.post_only {
        msg!("Trigger limit order can not be post only");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.has_oracle_price_offset() {
        msg!("Trigger limit can not have oracle offset");
        return Err(ErrorCode::InvalidOrder);
    }

    match order.trigger_condition {
        OrderTriggerCondition::Above => {
            if order.direction == PositionDirection::Long && order.price < order.trigger_price {
                msg!("If trigger condition is above and direction is long, limit price must be above trigger price");
                return Err(ErrorCode::InvalidOrder);
            }
        }
        OrderTriggerCondition::Below => {
            if order.direction == PositionDirection::Short && order.price > order.trigger_price {
                msg!("If trigger condition is below and direction is short, limit price must be below trigger price");
                return Err(ErrorCode::InvalidOrder);
            }
        }
    }

    let approximate_market_value = order
        .price
        .checked_mul(order.base_asset_amount)
        .unwrap_or(u128::MAX)
        .div(AMM_RESERVE_PRECISION)
        .div(MARK_PRICE_PRECISION / QUOTE_PRECISION);

    if approximate_market_value < state.min_order_quote_asset_amount {
        msg!("Order value < $0.50 ({:?})", approximate_market_value);
        return Err(ErrorCode::InvalidOrder);
    }

    Ok(())
}

fn validate_trigger_market_order(
    order: &Order,
    market: &Market,
    state: &State,
) -> ClearingHouseResult {
    validate_base_asset_amount(order, market)?;

    if order.price > 0 {
        msg!("Trigger market order should not have price");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.trigger_price == 0 {
        msg!("Trigger market order trigger_price == 0");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.quote_asset_amount != 0 {
        msg!("Trigger market order should not have a quote asset amount");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.post_only {
        msg!("Trigger market order can not be post only");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.has_oracle_price_offset() {
        msg!("Trigger market order can not have oracle offset");
        return Err(ErrorCode::InvalidOrder);
    }

    let approximate_market_value = order
        .trigger_price
        .checked_mul(order.base_asset_amount)
        .unwrap_or(u128::MAX)
        .div(AMM_RESERVE_PRECISION)
        .div(MARK_PRICE_PRECISION / QUOTE_PRECISION);

    // decide min trade size ($10?)
    if approximate_market_value < state.min_order_quote_asset_amount {
        msg!("Order value < $0.50 ({:?})", approximate_market_value);
        return Err(ErrorCode::InvalidOrder);
    }

    Ok(())
}

fn validate_base_asset_amount(order: &Order, market: &Market) -> ClearingHouseResult {
    if order.base_asset_amount == 0 {
        msg!("Order base_asset_amount cant be 0");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.base_asset_amount < market.amm.base_asset_amount_step_size {
        msg!("Order base_asset_amount smaller than market base asset amount step size");
        return Err(ErrorCode::InvalidOrder);
    }

    Ok(())
}

fn validate_quote_asset_amount(order: &Order, market: &Market) -> ClearingHouseResult {
    if order.quote_asset_amount == 0 {
        msg!("Order quote_asset_amount cant be 0");
        return Err(ErrorCode::InvalidOrder);
    }

    let quote_asset_reserve_amount =
        asset_to_reserve_amount(order.quote_asset_amount, market.amm.peg_multiplier)?;

    if quote_asset_reserve_amount < market.amm.minimum_quote_asset_trade_size {
        msg!("Order quote_asset_reserve_amount smaller than market minimum_quote_asset_trade_size");
        return Err(ErrorCode::InvalidOrder);
    }

    Ok(())
}

pub fn check_if_order_can_be_canceled(
    user: &User,
    order_index: usize,
    market_map: &MarketMap,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
    valid_oracle_price: Option<i128>,
    now: i64,
) -> ClearingHouseResult<bool> {
    if !user.orders[order_index].post_only {
        return Ok(true);
    }

    let base_asset_amount_market_can_fill = {
        let market = &market_map.get_ref(&user.orders[order_index].market_index)?;
        calculate_base_asset_amount_to_trade_for_limit(
            &user.orders[order_index],
            market,
            valid_oracle_price,
            now,
        )?
    };

    if base_asset_amount_market_can_fill > 0 {
        let meets_initial_margin_requirement =
            meets_initial_margin_requirement(user, market_map, bank_map, oracle_map)?;

        if meets_initial_margin_requirement {
            msg!(
                "Cant cancel as post only order={:?} can be filled for {:?} base asset amount",
                user.orders[order_index].order_id,
                base_asset_amount_market_can_fill,
            );

            return Ok(false);
        }
    }

    Ok(true)
}

pub fn validate_order_can_be_canceled(
    user: &User,
    order_index: usize,
    market_map: &MarketMap,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
    valid_oracle_price: Option<i128>,
    now: i64,
) -> ClearingHouseResult {
    let is_cancelable = check_if_order_can_be_canceled(
        user,
        order_index,
        market_map,
        bank_map,
        oracle_map,
        valid_oracle_price,
        now,
    )?;

    if !is_cancelable {
        return Err(ErrorCode::CantCancelPostOnlyOrder);
    }

    Ok(())
}

pub fn get_base_asset_amount_for_order(
    params: &OrderParams,
    market: &Market,
    position: &MarketPosition,
    base_asset_amount: u128,
) -> u128 {
    // if the order isnt reduce only or it doesnt specify base asset amount, return early
    if !params.reduce_only || base_asset_amount == 0 {
        return base_asset_amount;
    }

    // check that order reduces existing position
    if params.direction == PositionDirection::Long && position.base_asset_amount >= 0 {
        return base_asset_amount;
    }
    if params.direction == PositionDirection::Short && position.base_asset_amount <= 0 {
        return base_asset_amount;
    }

    // find the absolute difference between order base asset amount and order base asset amount
    let current_position_size = position.base_asset_amount.unsigned_abs();
    let difference = if current_position_size >= base_asset_amount {
        current_position_size - base_asset_amount
    } else {
        base_asset_amount - current_position_size
    };

    // if it leaves less than the markets base asset step size, round the order size to be the same as current position
    if difference <= market.amm.base_asset_amount_step_size {
        current_position_size
    } else {
        params.base_asset_amount
    }
}
