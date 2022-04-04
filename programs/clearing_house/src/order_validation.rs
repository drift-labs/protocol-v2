use crate::controller::position::PositionDirection;
use crate::error::*;
use crate::math::constants::*;
use crate::math::quote_asset::asset_to_reserve_amount;
use crate::state::market::Market;
use crate::state::order_state::OrderState;
use crate::state::user_orders::{Order, OrderTriggerCondition, OrderType};

use crate::context::OrderParams;
use crate::math::orders::{
    calculate_available_quote_asset_user_can_execute,
    calculate_base_asset_amount_to_trade_for_limit,
};
use crate::state::user::{MarketPosition, User, UserPositions};
use solana_program::msg;
use std::ops::Div;

pub fn validate_order(
    order: &Order,
    market: &Market,
    order_state: &OrderState,
    valid_oracle_price: Option<i128>,
) -> ClearingHouseResult {
    match order.order_type {
        OrderType::Market => validate_market_order(order, market)?,
        OrderType::Limit => validate_limit_order(order, market, order_state, valid_oracle_price)?,
        OrderType::TriggerMarket => validate_trigger_market_order(order, market, order_state)?,
        OrderType::TriggerLimit => validate_trigger_limit_order(order, market, order_state)?,
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

    Ok(())
}

fn validate_limit_order(
    order: &Order,
    market: &Market,
    order_state: &OrderState,
    valid_oracle_price: Option<i128>,
) -> ClearingHouseResult {
    validate_base_asset_amount(order, market)?;

    if order.price == 0 && !order.has_oracle_price_offset() {
        msg!("Limit order price == 0");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.price != 0 && order.has_oracle_price_offset() {
        msg!("Limit order price != 0 and oracle price offset is set");
        return Err(ErrorCode::InvalidOrder);
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
        validate_post_only_order(order, market, valid_oracle_price)?;
    }

    let limit_price = order.get_limit_price(valid_oracle_price)?;
    let approximate_market_value = limit_price
        .checked_mul(order.base_asset_amount)
        .or(Some(u128::MAX))
        .unwrap()
        .div(AMM_RESERVE_PRECISION)
        .div(MARK_PRICE_PRECISION / QUOTE_PRECISION);

    if approximate_market_value < order_state.min_order_quote_asset_amount {
        msg!("Order value < $0.50 ({:?})", approximate_market_value);
        return Err(ErrorCode::InvalidOrder);
    }

    Ok(())
}

fn validate_post_only_order(
    order: &Order,
    market: &Market,
    valid_oracle_price: Option<i128>,
) -> ClearingHouseResult {
    let base_asset_amount_market_can_fill =
        calculate_base_asset_amount_to_trade_for_limit(order, market, valid_oracle_price)?;

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
    order_state: &OrderState,
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
        .or(Some(u128::MAX))
        .unwrap()
        .div(AMM_RESERVE_PRECISION)
        .div(MARK_PRICE_PRECISION / QUOTE_PRECISION);

    if approximate_market_value < order_state.min_order_quote_asset_amount {
        msg!("Order value < $0.50 ({:?})", approximate_market_value);
        return Err(ErrorCode::InvalidOrder);
    }

    Ok(())
}

fn validate_trigger_market_order(
    order: &Order,
    market: &Market,
    order_state: &OrderState,
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
        .or(Some(u128::MAX))
        .unwrap()
        .div(AMM_RESERVE_PRECISION)
        .div(MARK_PRICE_PRECISION / QUOTE_PRECISION);

    // decide min trade size ($10?)
    if approximate_market_value < order_state.min_order_quote_asset_amount {
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

    if order.base_asset_amount < market.amm.minimum_base_asset_trade_size {
        msg!("Order base_asset_amount smaller than market minimum_base_asset_trade_size");
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

pub fn validate_order_can_be_canceled(
    order: &Order,
    market: &Market,
    valid_oracle_price: Option<i128>,
) -> ClearingHouseResult {
    if !order.post_only {
        return Ok(());
    }

    let base_asset_amount_market_can_fill =
        calculate_base_asset_amount_to_trade_for_limit(order, market, valid_oracle_price)?;

    if base_asset_amount_market_can_fill > 0 {
        msg!(
            "Cant cancel as post only order can be filled for {} base asset amount",
            base_asset_amount_market_can_fill
        );
        return Err(ErrorCode::CantCancelPostOnlyOrder);
    }

    Ok(())
}

pub fn get_base_asset_amount_for_order(
    params: &OrderParams,
    market: &Market,
    position: &MarketPosition,
) -> u128 {
    // if the order isnt reduce only or it doesnt specify base asset amount, return early
    if !params.reduce_only || params.base_asset_amount == 0 {
        return params.base_asset_amount;
    }

    // check that order reduces existing position
    if params.direction == PositionDirection::Long && position.base_asset_amount >= 0 {
        return params.base_asset_amount;
    }
    if params.direction == PositionDirection::Short && position.base_asset_amount <= 0 {
        return params.base_asset_amount;
    }

    // find the absolute difference between order base asset amount and order base asset amount
    let current_position_size = position.base_asset_amount.unsigned_abs();
    let difference = if current_position_size >= params.base_asset_amount {
        current_position_size - params.base_asset_amount
    } else {
        params.base_asset_amount - current_position_size
    };

    // if it leaves less than the markets minimum base size, round the order size to be the same as current position
    if difference <= market.amm.minimum_base_asset_trade_size {
        current_position_size
    } else {
        params.base_asset_amount
    }
}
