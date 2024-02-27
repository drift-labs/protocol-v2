use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::AUCTION_DERIVE_PRICE_FRACTION;
use crate::math::orders::standardize_price;
use crate::math::safe_math::SafeMath;
use crate::state::oracle::OraclePriceData;
use crate::state::user::{Order, OrderType};
use solana_program::msg;

use crate::state::perp_market::PerpMarket;
use crate::OrderParams;
use std::cmp::min;

#[cfg(test)]
mod tests;

pub fn calculate_auction_prices(
    oracle_price_data: &OraclePriceData,
    direction: PositionDirection,
    limit_price: u64,
) -> DriftResult<(i64, i64)> {
    let oracle_price = oracle_price_data.price;
    let limit_price = limit_price.cast::<i64>()?;
    if limit_price > 0 {
        let (auction_start_price, auction_end_price) = match direction {
            // Long and limit price is better than oracle price
            PositionDirection::Long if limit_price < oracle_price => {
                let limit_derive_start_price =
                    limit_price.safe_sub(limit_price / AUCTION_DERIVE_PRICE_FRACTION)?;
                let oracle_derive_start_price =
                    oracle_price.safe_sub(oracle_price / AUCTION_DERIVE_PRICE_FRACTION)?;

                (
                    limit_derive_start_price.min(oracle_derive_start_price),
                    limit_price,
                )
            }
            // Long and limit price is worse than oracle price
            PositionDirection::Long if limit_price >= oracle_price => {
                let oracle_derive_end_price =
                    oracle_price.safe_add(oracle_price / AUCTION_DERIVE_PRICE_FRACTION)?;

                (oracle_price, limit_price.min(oracle_derive_end_price))
            }
            // Short and limit price is better than oracle price
            PositionDirection::Short if limit_price > oracle_price => {
                let limit_derive_start_price =
                    limit_price.safe_add(limit_price / AUCTION_DERIVE_PRICE_FRACTION)?;
                let oracle_derive_start_price =
                    oracle_price.safe_add(oracle_price / AUCTION_DERIVE_PRICE_FRACTION)?;

                (
                    limit_derive_start_price.max(oracle_derive_start_price),
                    limit_price,
                )
            }
            // Short and limit price is worse than oracle price
            PositionDirection::Short if limit_price <= oracle_price => {
                let oracle_derive_end_price =
                    oracle_price.safe_sub(oracle_price / AUCTION_DERIVE_PRICE_FRACTION)?;

                (oracle_price, limit_price.max(oracle_derive_end_price))
            }
            _ => unreachable!(),
        };

        return Ok((auction_start_price, auction_end_price));
    }

    let auction_end_price = match direction {
        PositionDirection::Long => {
            oracle_price.safe_add(oracle_price / AUCTION_DERIVE_PRICE_FRACTION)?
        }
        PositionDirection::Short => {
            oracle_price.safe_sub(oracle_price / AUCTION_DERIVE_PRICE_FRACTION)?
        }
    };

    Ok((oracle_price, auction_end_price))
}

pub fn calculate_auction_price(
    order: &Order,
    slot: u64,
    tick_size: u64,
    valid_oracle_price: Option<i64>,
) -> DriftResult<u64> {
    match order.order_type {
        OrderType::Market
        | OrderType::TriggerMarket
        | OrderType::Limit
        | OrderType::TriggerLimit => {
            calculate_auction_price_for_fixed_auction(order, slot, tick_size)
        }
        OrderType::Oracle => calculate_auction_price_for_oracle_offset_auction(
            order,
            slot,
            tick_size,
            valid_oracle_price,
        ),
    }
}

fn calculate_auction_price_for_fixed_auction(
    order: &Order,
    slot: u64,
    tick_size: u64,
) -> DriftResult<u64> {
    let slots_elapsed = slot.safe_sub(order.slot)?;

    let delta_numerator = min(slots_elapsed, order.auction_duration.cast()?);
    let delta_denominator = order.auction_duration;

    let auction_start_price = order.auction_start_price.cast::<u64>()?;
    let auction_end_price = order.auction_end_price.cast::<u64>()?;

    if delta_denominator == 0 {
        return standardize_price(auction_end_price, tick_size, order.direction);
    }

    let price_delta = match order.direction {
        PositionDirection::Long => auction_end_price
            .safe_sub(auction_start_price)?
            .safe_mul(delta_numerator.cast()?)?
            .safe_div(delta_denominator.cast()?)?,
        PositionDirection::Short => auction_start_price
            .safe_sub(auction_end_price)?
            .safe_mul(delta_numerator.cast()?)?
            .safe_div(delta_denominator.cast()?)?,
    };

    let price = match order.direction {
        PositionDirection::Long => auction_start_price.safe_add(price_delta)?,
        PositionDirection::Short => auction_start_price.safe_sub(price_delta)?,
    };

    standardize_price(price, tick_size, order.direction)
}

fn calculate_auction_price_for_oracle_offset_auction(
    order: &Order,
    slot: u64,
    tick_size: u64,
    valid_oracle_price: Option<i64>,
) -> DriftResult<u64> {
    let oracle_price = valid_oracle_price.ok_or_else(|| {
        msg!("Could not find oracle too calculate oracle offset auction price");
        ErrorCode::OracleNotFound
    })?;

    let slots_elapsed = slot.safe_sub(order.slot)?;

    let delta_numerator = min(slots_elapsed, order.auction_duration.cast()?);
    let delta_denominator = order.auction_duration;

    let auction_start_price_offset = order.auction_start_price;
    let auction_end_price_offset = order.auction_end_price;

    if delta_denominator == 0 {
        let price = oracle_price.safe_add(auction_end_price_offset)?;

        if price <= 0 {
            msg!("Oracle offset auction price below zero: {}", price);
            return Err(ErrorCode::InvalidOracleOffset);
        }

        return standardize_price(price.cast()?, tick_size, order.direction);
    }

    let price_offset_delta = match order.direction {
        PositionDirection::Long => auction_end_price_offset
            .safe_sub(auction_start_price_offset)?
            .safe_mul(delta_numerator.cast()?)?
            .safe_div(delta_denominator.cast()?)?,
        PositionDirection::Short => auction_start_price_offset
            .safe_sub(auction_end_price_offset)?
            .safe_mul(delta_numerator.cast()?)?
            .safe_div(delta_denominator.cast()?)?,
    };

    let price_offset = match order.direction {
        PositionDirection::Long => auction_start_price_offset.safe_add(price_offset_delta)?,
        PositionDirection::Short => auction_start_price_offset.safe_sub(price_offset_delta)?,
    };

    let price = standardize_price(
        oracle_price.safe_add(price_offset)?.max(0).cast()?,
        tick_size,
        order.direction,
    )?;

    if price == 0 {
        msg!("Oracle offset auction price below zero: {}", price);
        return Err(ErrorCode::InvalidOracleOffset);
    }

    Ok(price)
}

pub fn is_auction_complete(order_slot: u64, auction_duration: u8, slot: u64) -> DriftResult<bool> {
    if auction_duration == 0 {
        return Ok(true);
    }

    let slots_elapsed = slot.safe_sub(order_slot)?;

    Ok(slots_elapsed > auction_duration.cast()?)
}

pub fn is_amm_available_liquidity_source(
    order: &Order,
    min_auction_duration: u8,
    slot: u64,
) -> DriftResult<bool> {
    is_auction_complete(order.slot, min_auction_duration, slot)
}

pub fn calculate_auction_params_for_trigger_order(
    order: &Order,
    oracle_price_data: &OraclePriceData,
    min_auction_duration: u8,
    perp_market: Option<&PerpMarket>,
) -> DriftResult<(u8, i64, i64)> {
    let auction_duration = min_auction_duration;

    if let Some(perp_market) = perp_market {
        let (auction_start_price, auction_end_price, derived_auction_duration) =
            OrderParams::derive_market_order_auction_params(
                perp_market,
                order.direction,
                oracle_price_data.price,
                order.price,
            )?;

        let auction_duration = auction_duration.max(derived_auction_duration);

        Ok((auction_duration, auction_start_price, auction_end_price))
    } else {
        let (auction_start_price, auction_end_price) =
            calculate_auction_prices(oracle_price_data, order.direction, order.price)?;

        Ok((auction_duration, auction_start_price, auction_end_price))
    }
}
