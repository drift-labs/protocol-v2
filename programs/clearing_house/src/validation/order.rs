use solana_program::msg;

use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};

use crate::math::orders::{
    calculate_base_asset_amount_to_fill_up_to_limit_price, is_multiple_of_step_size,
    order_breaches_oracle_price_limits,
};
use crate::state::perp_market::PerpMarket;
use crate::state::user::{Order, OrderType};
use crate::validate;

pub fn validate_order(
    order: &Order,
    market: &PerpMarket,
    valid_oracle_price: Option<i128>,
    slot: u64,
) -> ClearingHouseResult {
    match order.order_type {
        OrderType::Market => {
            validate_market_order(order, market.amm.order_step_size, market.amm.min_order_size)?
        }
        OrderType::Limit => validate_limit_order(order, market, valid_oracle_price, slot)?,
        OrderType::TriggerMarket => validate_trigger_market_order(
            order,
            market.amm.order_step_size,
            market.amm.min_order_size,
        )?,
        OrderType::TriggerLimit => validate_trigger_limit_order(
            order,
            market.amm.order_step_size,
            market.amm.min_order_size,
        )?,
    }

    Ok(())
}

fn validate_market_order(
    order: &Order,
    step_size: u64,
    min_order_size: u64,
) -> ClearingHouseResult {
    validate_base_asset_amount(order, step_size, min_order_size, order.reduce_only)?;

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
    market: &PerpMarket,
    valid_oracle_price: Option<i128>,
    slot: u64,
) -> ClearingHouseResult {
    validate_base_asset_amount(
        order,
        market.amm.order_step_size,
        market.amm.min_order_size,
        order.reduce_only,
    )?;

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
            order,
            valid_oracle_price.ok_or(ErrorCode::InvalidOracle)?,
            slot,
            market.amm.order_tick_size,
            market.margin_ratio_initial as u128,
            market.margin_ratio_maintenance as u128,
        )?;

        if order_breaches_oracle_price_limits {
            return Err(ErrorCode::OrderBreachesOraclePriceLimits);
        }
    }

    Ok(())
}

fn validate_post_only_order(
    order: &Order,
    market: &PerpMarket,
    valid_oracle_price: Option<i128>,
    slot: u64,
) -> ClearingHouseResult {
    let base_asset_amount_market_can_fill = calculate_base_asset_amount_to_fill_up_to_limit_price(
        order,
        market,
        order.get_optional_limit_price(valid_oracle_price, slot, market.amm.order_tick_size)?,
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
    step_size: u64,
    min_order_size: u64,
) -> ClearingHouseResult {
    validate_base_asset_amount(order, step_size, min_order_size, order.reduce_only)?;

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

    Ok(())
}

fn validate_trigger_market_order(
    order: &Order,
    step_size: u64,
    min_order_size: u64,
) -> ClearingHouseResult {
    validate_base_asset_amount(order, step_size, min_order_size, order.reduce_only)?;

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

    Ok(())
}

fn validate_base_asset_amount(
    order: &Order,
    step_size: u64,
    min_order_size: u64,
    reduce_only: bool,
) -> ClearingHouseResult {
    if order.base_asset_amount == 0 {
        msg!("Order base_asset_amount cant be 0");
        return Err(ErrorCode::InvalidOrder);
    }

    validate!(
        is_multiple_of_step_size(order.base_asset_amount, step_size)?,
        ErrorCode::InvalidOrder,
        "Order base asset amount ({}) not a multiple of the step size ({})",
        order.base_asset_amount,
        step_size
    )?;

    validate!(
        reduce_only || order.base_asset_amount >= min_order_size,
        ErrorCode::InvalidOrder,
        "Order base_asset_amount ({}) < min_order_size ({})",
        order.base_asset_amount,
        min_order_size
    )?;

    Ok(())
}

pub fn validate_spot_order(
    order: &Order,
    valid_oracle_price: Option<i128>,
    slot: u64,
    step_size: u64,
    tick_size: u64,
    margin_ratio_initial: u128,
    margin_ratio_maintenance: u128,
    min_order_size: u64,
) -> ClearingHouseResult {
    match order.order_type {
        OrderType::Market => validate_market_order(order, step_size, min_order_size)?,
        OrderType::Limit => validate_spot_limit_order(
            order,
            valid_oracle_price,
            slot,
            step_size,
            tick_size,
            min_order_size,
            margin_ratio_initial,
            margin_ratio_maintenance,
        )?,
        OrderType::TriggerMarket => {
            validate_trigger_market_order(order, step_size, min_order_size)?
        }
        OrderType::TriggerLimit => validate_trigger_limit_order(order, step_size, min_order_size)?,
    }

    Ok(())
}

fn validate_spot_limit_order(
    order: &Order,
    valid_oracle_price: Option<i128>,
    slot: u64,
    step_size: u64,
    tick_size: u64,
    min_order_size: u64,
    margin_ratio_initial: u128,
    margin_ratio_maintenance: u128,
) -> ClearingHouseResult {
    validate_base_asset_amount(order, step_size, min_order_size, order.reduce_only)?;

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
        let order_breaches_oracle_price_limits = order_breaches_oracle_price_limits(
            order,
            valid_oracle_price.ok_or(ErrorCode::InvalidOracle)?,
            slot,
            tick_size,
            margin_ratio_initial,
            margin_ratio_maintenance,
        )?;

        if order_breaches_oracle_price_limits {
            return Err(ErrorCode::OrderBreachesOraclePriceLimits);
        }
    }

    Ok(())
}
