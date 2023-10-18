use solana_program::msg;

use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};

use crate::math::casting::Cast;
use crate::math::orders::{
    calculate_base_asset_amount_to_fill_up_to_limit_price, is_multiple_of_step_size,
};
use crate::state::perp_market::PerpMarket;
use crate::state::user::{Order, OrderTriggerCondition, OrderType};
use crate::validate;

pub fn validate_order(
    order: &Order,
    market: &PerpMarket,
    valid_oracle_price: Option<i64>,
    slot: u64,
) -> DriftResult {
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
        OrderType::Oracle => {
            validate_oracle_order(order, market.amm.order_step_size, market.amm.min_order_size)?
        }
    }

    Ok(())
}

fn validate_market_order(order: &Order, step_size: u64, min_order_size: u64) -> DriftResult {
    validate_base_asset_amount(order, step_size, min_order_size, order.reduce_only)?;

    validate!(
        order.auction_start_price > 0 && order.auction_end_price > 0,
        ErrorCode::InvalidOrderAuction,
        "Auction start and end price must be greater than 0"
    )?;

    validate_auction_params(order)?;

    if order.trigger_price > 0 {
        msg!("Market should not have trigger price");
        return Err(ErrorCode::InvalidOrderTrigger);
    }

    if order.post_only {
        msg!("Market order can not be post only");
        return Err(ErrorCode::InvalidOrderPostOnly);
    }

    if order.has_oracle_price_offset() {
        msg!("Market order can not have oracle offset");
        return Err(ErrorCode::InvalidOrderOracleOffset);
    }

    if order.immediate_or_cancel {
        msg!("Market order can not be immediate or cancel");
        return Err(ErrorCode::InvalidOrderIOC);
    }

    Ok(())
}

fn validate_oracle_order(order: &Order, step_size: u64, min_order_size: u64) -> DriftResult {
    validate_base_asset_amount(order, step_size, min_order_size, order.reduce_only)?;

    match order.direction {
        PositionDirection::Long => {
            if order.auction_start_price > order.auction_end_price {
                msg!(
                    "Auction start price offset ({}) was greater than auction end price offset ({})",
                    order.auction_start_price,
                    order.auction_end_price
                );
                return Err(ErrorCode::InvalidOrderAuction);
            }

            if order.has_oracle_price_offset()
                && order.auction_end_price > order.oracle_price_offset.cast()?
            {
                msg!(
                    "Auction end price offset ({}) was greater than oracle price offset ({})",
                    order.auction_end_price,
                    order.oracle_price_offset
                );
                return Err(ErrorCode::InvalidOrderAuction);
            }
        }
        PositionDirection::Short => {
            if order.auction_start_price < order.auction_end_price {
                msg!(
                    "Auction start price ({}) was less than auction end price ({})",
                    order.auction_start_price,
                    order.auction_end_price
                );
                return Err(ErrorCode::InvalidOrderAuction);
            }

            if order.has_oracle_price_offset()
                && order.auction_end_price < order.oracle_price_offset.cast()?
            {
                msg!(
                    "Auction end price offset ({}) was less than oracle price offset ({})",
                    order.auction_end_price,
                    order.oracle_price_offset
                );
                return Err(ErrorCode::InvalidOrderAuction);
            }
        }
    }

    if order.trigger_price > 0 {
        msg!("Oracle order should not have trigger price");
        return Err(ErrorCode::InvalidOrderTrigger);
    }

    if order.post_only {
        msg!("Oracle order can not be post only");
        return Err(ErrorCode::InvalidOrderPostOnly);
    }

    if order.price > 0 {
        msg!("Oracle order can not have a price");
        return Err(ErrorCode::InvalidOrderLimitPrice);
    }

    if order.immediate_or_cancel {
        msg!("Oracle order can not be immediate or cancel");
        return Err(ErrorCode::InvalidOrderIOC);
    }

    Ok(())
}

fn validate_limit_order(
    order: &Order,
    market: &PerpMarket,
    valid_oracle_price: Option<i64>,
    slot: u64,
) -> DriftResult {
    validate_base_asset_amount(
        order,
        market.amm.order_step_size,
        market.amm.min_order_size,
        order.reduce_only,
    )?;

    if order.price == 0 && !order.has_oracle_price_offset() {
        msg!("Limit order price == 0");
        return Err(ErrorCode::InvalidOrderLimitPrice);
    }

    if order.has_oracle_price_offset() && order.price != 0 {
        msg!("Limit order price must be 0 for taker oracle offset order");
        return Err(ErrorCode::InvalidOrderLimitPrice);
    }

    if order.trigger_price > 0 {
        msg!("Limit order should not have trigger price");
        return Err(ErrorCode::InvalidOrderTrigger);
    }

    if order.post_only {
        validate!(
            !order.has_auction(),
            ErrorCode::InvalidOrder,
            "post only limit order cant have auction"
        )?;

        validate_post_only_order(order, market, valid_oracle_price, slot)?;
    }

    validate_limit_order_auction_params(order)?;

    Ok(())
}

fn validate_limit_order_auction_params(order: &Order) -> DriftResult {
    if order.has_auction() {
        validate!(
            !order.has_oracle_price_offset(),
            ErrorCode::InvalidOrder,
            "limit order with auction can not have an oracle price offset"
        )?;

        validate_auction_params(order)?;
    } else {
        validate!(
            order.auction_start_price == 0,
            ErrorCode::InvalidOrder,
            "limit order without auction can not have an auction start price"
        )?;

        validate!(
            order.auction_end_price == 0,
            ErrorCode::InvalidOrder,
            "limit order without auction can not have an auction end price"
        )?;
    }

    Ok(())
}

fn validate_post_only_order(
    order: &Order,
    market: &PerpMarket,
    valid_oracle_price: Option<i64>,
    slot: u64,
) -> DriftResult {
    let limit_price =
        order.force_get_limit_price(valid_oracle_price, None, slot, market.amm.order_tick_size)?;

    let base_asset_amount_market_can_fill = calculate_base_asset_amount_to_fill_up_to_limit_price(
        order,
        market,
        Some(limit_price),
        None,
    )?;

    if base_asset_amount_market_can_fill != 0 {
        msg!(
            "Post-only order can immediately fill {} base asset amount",
            base_asset_amount_market_can_fill,
        );

        if market.amm.last_update_slot != slot {
            msg!(
                "market.amm.last_update_slot={} behind current slot={}",
                market.amm.last_update_slot,
                slot
            );
        }

        let mut invalid = true;
        if let Some(valid_oracle_price) = valid_oracle_price {
            if (valid_oracle_price > limit_price.cast()?
                && order.direction == PositionDirection::Long)
                || (valid_oracle_price < limit_price.cast()?
                    && order.direction == PositionDirection::Short)
            {
                invalid = false;
            }
        }

        if invalid {
            return Err(ErrorCode::PlacePostOnlyLimitFailure);
        }
    }

    Ok(())
}

fn validate_trigger_limit_order(order: &Order, step_size: u64, min_order_size: u64) -> DriftResult {
    validate_base_asset_amount(order, step_size, min_order_size, order.reduce_only)?;

    if !matches!(
        order.trigger_condition,
        OrderTriggerCondition::Above | OrderTriggerCondition::Below
    ) {
        msg!("Invalid trigger condition, must be Above or Below");
        return Err(ErrorCode::InvalidTriggerOrderCondition);
    }

    if order.price == 0 {
        msg!("Trigger limit order price == 0");
        return Err(ErrorCode::InvalidOrderLimitPrice);
    }

    if order.trigger_price == 0 {
        msg!("Trigger price == 0");
        return Err(ErrorCode::InvalidOrderTrigger);
    }

    if order.post_only {
        msg!("Trigger limit order can not be post only");
        return Err(ErrorCode::InvalidOrderPostOnly);
    }

    if order.has_oracle_price_offset() {
        msg!("Trigger limit can not have oracle offset");
        return Err(ErrorCode::InvalidOrderOracleOffset);
    }

    Ok(())
}

fn validate_trigger_market_order(
    order: &Order,
    step_size: u64,
    min_order_size: u64,
) -> DriftResult {
    validate_base_asset_amount(order, step_size, min_order_size, order.reduce_only)?;

    if !matches!(
        order.trigger_condition,
        OrderTriggerCondition::Above | OrderTriggerCondition::Below
    ) {
        msg!("Invalid trigger condition, must be Above or Below");
        return Err(ErrorCode::InvalidTriggerOrderCondition);
    }

    if order.price > 0 {
        msg!("Trigger market order should not have price");
        return Err(ErrorCode::InvalidOrderLimitPrice);
    }

    if order.trigger_price == 0 {
        msg!("Trigger market order trigger_price == 0");
        return Err(ErrorCode::InvalidOrderTrigger);
    }

    if order.post_only {
        msg!("Trigger market order can not be post only");
        return Err(ErrorCode::InvalidOrderPostOnly);
    }

    if order.has_oracle_price_offset() {
        msg!("Trigger market order can not have oracle offset");
        return Err(ErrorCode::InvalidOrderOracleOffset);
    }

    Ok(())
}

fn validate_base_asset_amount(
    order: &Order,
    step_size: u64,
    min_order_size: u64,
    reduce_only: bool,
) -> DriftResult {
    if order.base_asset_amount == 0 {
        msg!("Order base_asset_amount cant be 0");
        return Err(ErrorCode::InvalidOrderSizeTooSmall);
    }

    validate!(
        is_multiple_of_step_size(order.base_asset_amount, step_size)?,
        ErrorCode::InvalidOrderNotStepSizeMultiple,
        "Order base asset amount ({}) not a multiple of the step size ({})",
        order.base_asset_amount,
        step_size
    )?;

    validate!(
        reduce_only || order.base_asset_amount >= min_order_size,
        ErrorCode::InvalidOrderMinOrderSize,
        "Order base_asset_amount ({}) < min_order_size ({})",
        order.base_asset_amount,
        min_order_size
    )?;

    Ok(())
}

fn validate_auction_params(order: &Order) -> DriftResult {
    validate!(
        order.auction_start_price != 0,
        ErrorCode::InvalidOrderAuction,
        "Auction start price was 0"
    )?;

    validate!(
        order.auction_end_price != 0,
        ErrorCode::InvalidOrderAuction,
        "Auction end price was 0"
    )?;

    match order.direction {
        PositionDirection::Long => {
            if order.auction_start_price > order.auction_end_price {
                msg!(
                    "Auction start price ({}) was greater than auction end price ({})",
                    order.auction_start_price,
                    order.auction_end_price
                );
                return Err(ErrorCode::InvalidOrderAuction);
            }

            if order.price != 0 && order.price < order.auction_end_price.cast()? {
                msg!(
                    "Order price ({}) was less than auction end price ({})",
                    order.price,
                    order.auction_end_price
                );
                return Err(ErrorCode::InvalidOrderAuction);
            }
        }
        PositionDirection::Short => {
            if order.auction_start_price < order.auction_end_price {
                msg!(
                    "Auction start price ({}) was less than auction end price ({})",
                    order.auction_start_price,
                    order.auction_end_price
                );
                return Err(ErrorCode::InvalidOrderAuction);
            }

            if order.price != 0 && order.price > order.auction_end_price.cast()? {
                msg!(
                    "Order price ({}) was greater than auction end price ({})",
                    order.price,
                    order.auction_end_price
                );
                return Err(ErrorCode::InvalidOrderAuction);
            }
        }
    }

    Ok(())
}

pub fn validate_spot_order(order: &Order, step_size: u64, min_order_size: u64) -> DriftResult {
    match order.order_type {
        OrderType::Market => validate_market_order(order, step_size, min_order_size)?,
        OrderType::Limit => validate_spot_limit_order(order, step_size, min_order_size)?,
        OrderType::TriggerMarket => {
            validate_trigger_market_order(order, step_size, min_order_size)?
        }
        OrderType::TriggerLimit => validate_trigger_limit_order(order, step_size, min_order_size)?,
        OrderType::Oracle => validate_oracle_order(order, step_size, min_order_size)?,
    }

    Ok(())
}

fn validate_spot_limit_order(order: &Order, step_size: u64, min_order_size: u64) -> DriftResult {
    validate_base_asset_amount(order, step_size, min_order_size, order.reduce_only)?;

    if order.price == 0 && !order.has_oracle_price_offset() {
        msg!("Limit order price == 0");
        return Err(ErrorCode::InvalidOrderLimitPrice);
    }

    if order.has_oracle_price_offset() && order.price != 0 {
        msg!("Limit order price must be 0 for taker oracle offset order");
        return Err(ErrorCode::InvalidOrderOracleOffset);
    }

    if order.trigger_price > 0 {
        msg!("Limit order should not have trigger price");
        return Err(ErrorCode::InvalidOrderTrigger);
    }

    if order.post_only {
        validate!(
            !order.has_auction(),
            ErrorCode::InvalidOrder,
            "post only limit order cant have auction"
        )?;
    }

    validate_limit_order_auction_params(order)?;

    Ok(())
}
