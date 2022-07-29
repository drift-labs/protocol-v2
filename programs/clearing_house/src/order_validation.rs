use std::ops::Div;

use solana_program::msg;

use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::constants::*;
use crate::math::orders::{
    calculate_base_asset_amount_to_fill_up_to_limit_price, order_breaches_oracle_price_limits,
};
use crate::state::market::Market;
use crate::state::state::State;
use crate::state::user::{Order, OrderTriggerCondition, OrderType};

pub fn validate_order(
    order: &Order,
    market: &Market,
    state: &State,
    valid_oracle_price: Option<i128>,
    slot: u64,
) -> ClearingHouseResult {
    match order.order_type {
        OrderType::Market => validate_market_order(order, market)?,
        OrderType::Limit => validate_limit_order(order, market, state, valid_oracle_price, slot)?,
        OrderType::TriggerMarket => validate_trigger_market_order(order, market, state)?,
        OrderType::TriggerLimit => validate_trigger_limit_order(order, market, state)?,
    }

    Ok(())
}

fn validate_market_order(order: &Order, market: &Market) -> ClearingHouseResult {
    validate_base_asset_amount(order, market)?;

    match order.direction {
        PositionDirection::Long if order.auction_start_price >= order.auction_end_price => {
            msg!(
                "Auction start price ({}) was greater than auction end price ({})",
                order.auction_start_price,
                order.auction_end_price
            );
            return Err(ErrorCode::InvalidOrder);
        }
        PositionDirection::Short if order.auction_start_price <= order.auction_end_price => {
            msg!(
                "Auction start price ({}) was less than auction end price ({})",
                order.auction_start_price,
                order.auction_end_price
            );
            return Err(ErrorCode::InvalidOrder);
        }
        _ => {}
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
    slot: u64,
) -> ClearingHouseResult {
    validate_base_asset_amount(order, market)?;

    if order.price == 0 && !order.has_oracle_price_offset() {
        msg!("Limit order price == 0");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.has_oracle_price_offset() && order.price != 0 {
        msg!("Limit order price must be 0 for taker oracle offset order");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.trigger_price > 0 {
        msg!("Limit order should not have trigger price");
        return Err(ErrorCode::InvalidOrder);
    }

    if order.post_only {
        validate_post_only_order(order, market, valid_oracle_price, slot)?;

        let order_breaches_oracle_price_limits = order_breaches_oracle_price_limits(
            market,
            order,
            valid_oracle_price.ok_or(ErrorCode::InvalidOracle)?,
            slot,
        )?;

        if order_breaches_oracle_price_limits {
            return Err(ErrorCode::OrderBreachesOraclePriceLimits);
        }
    }

    let limit_price = order.get_limit_price(&market.amm, valid_oracle_price, slot)?;
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
    slot: u64,
) -> ClearingHouseResult {
    let base_asset_amount_market_can_fill = calculate_base_asset_amount_to_fill_up_to_limit_price(
        order,
        market,
        order.get_limit_price(&market.amm, valid_oracle_price, slot)?,
    )?;

    if base_asset_amount_market_can_fill != 0 {
        msg!(
            "Post-only order can immediately fill {} base asset amount",
            base_asset_amount_market_can_fill
        );

        if !order.is_jit_maker() {
            return Err(ErrorCode::InvalidOrder);
        }
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
