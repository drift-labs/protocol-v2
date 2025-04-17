use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::AUCTION_DERIVE_PRICE_FRACTION;
use crate::math::orders::standardize_price;
use crate::math::safe_math::SafeMath;
use crate::msg;
use crate::state::oracle::OraclePriceData;
use crate::state::perp_market::ContractTier;
use crate::state::user::{Order, OrderBitFlag, OrderType};

use crate::state::fill_mode::FillMode;
use crate::state::perp_market::{AMMAvailability, PerpMarket};
use crate::{OrderParams, MAX_PREDICTION_MARKET_PRICE};
use std::cmp::min;

use super::orders::get_posted_slot_from_clock_slot;

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
    is_prediction_market: bool,
) -> DriftResult<u64> {
    match order.order_type {
        OrderType::TriggerMarket if order.is_bit_flag_set(OrderBitFlag::OracleTriggerMarket) => {
            calculate_auction_price_for_oracle_offset_auction(
                order,
                slot,
                tick_size,
                valid_oracle_price,
                is_prediction_market,
            )
        }
        OrderType::Market | OrderType::TriggerMarket | OrderType::TriggerLimit => {
            calculate_auction_price_for_fixed_auction(order, slot, tick_size)
        }
        OrderType::Limit => {
            if order.has_oracle_price_offset() {
                calculate_auction_price_for_oracle_offset_auction(
                    order,
                    slot,
                    tick_size,
                    valid_oracle_price,
                    is_prediction_market,
                )
            } else {
                calculate_auction_price_for_fixed_auction(order, slot, tick_size)
            }
        }
        OrderType::Oracle => calculate_auction_price_for_oracle_offset_auction(
            order,
            slot,
            tick_size,
            valid_oracle_price,
            is_prediction_market,
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
    is_prediction_market: bool,
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
        let mut price = oracle_price
            .safe_add(auction_end_price_offset)?
            .max(tick_size.cast()?)
            .cast::<u64>()?;

        if is_prediction_market {
            price = price.min(MAX_PREDICTION_MARKET_PRICE);
        }

        return standardize_price(price, tick_size, order.direction);
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

    let mut price = oracle_price
        .safe_add(price_offset)?
        .max(tick_size.cast()?)
        .cast::<u64>()?;

    if is_prediction_market {
        price = price.min(MAX_PREDICTION_MARKET_PRICE);
    }

    standardize_price(price, tick_size, order.direction)
}

pub fn is_auction_complete(order_slot: u64, auction_duration: u8, slot: u64) -> DriftResult<bool> {
    if auction_duration == 0 {
        return Ok(true);
    }

    let slots_elapsed = slot.safe_sub(order_slot)?;

    Ok(slots_elapsed > auction_duration.cast()?)
}

pub fn can_fill_with_amm(
    amm_availability: AMMAvailability,
    valid_oracle_price: Option<i64>,
    order: &Order,
    min_auction_duration: u8,
    slot: u64,
    fill_mode: FillMode,
) -> DriftResult<bool> {
    Ok(amm_availability != AMMAvailability::Unavailable
        && valid_oracle_price.is_some()
        && (amm_availability == AMMAvailability::Immediate
            || is_amm_available_liquidity_source(order, min_auction_duration, slot, fill_mode)?))
}

pub fn is_amm_available_liquidity_source(
    order: &Order,
    min_auction_duration: u8,
    slot: u64,
    fill_mode: FillMode,
) -> DriftResult<bool> {
    if fill_mode.is_liquidation() {
        return Ok(true);
    }

    if order.is_bit_flag_set(OrderBitFlag::SafeTriggerOrder) {
        return Ok(true);
    }

    if order.is_signed_msg() {
        let clock_slot_tail = get_posted_slot_from_clock_slot(slot);
        return Ok(clock_slot_tail.wrapping_sub(order.posted_slot_tail) >= min_auction_duration);
    }

    Ok(is_auction_complete(order.slot, min_auction_duration, slot)?)
}

pub fn calculate_auction_params_for_trigger_order(
    order: &Order,
    oracle_price_data: &OraclePriceData,
    min_auction_duration: u8,
    perp_market: Option<&PerpMarket>,
) -> DriftResult<(u8, i64, i64)> {
    let auction_duration = min_auction_duration;

    if let Some(perp_market) = perp_market {
        // negative buffer is crossing
        let auction_start_buffer = if perp_market
            .contract_tier
            .is_as_safe_as_contract(&ContractTier::B)
        {
            -500
        } else {
            -3_500
        };

        let (auction_start_price, auction_end_price, derived_auction_duration) =
            if matches!(order.order_type, OrderType::TriggerMarket) {
                OrderParams::derive_oracle_order_auction_params(
                    perp_market,
                    order.direction,
                    oracle_price_data.price,
                    None,
                    auction_start_buffer,
                )?
            } else {
                OrderParams::derive_market_order_auction_params(
                    perp_market,
                    order.direction,
                    oracle_price_data.price,
                    order.price,
                    auction_start_buffer,
                )?
            };

        let auction_duration = auction_duration.max(derived_auction_duration);

        Ok((auction_duration, auction_start_price, auction_end_price))
    } else {
        let (auction_start_price, auction_end_price) =
            calculate_auction_prices(oracle_price_data, order.direction, order.price)?;

        Ok((auction_duration, auction_start_price, auction_end_price))
    }
}
