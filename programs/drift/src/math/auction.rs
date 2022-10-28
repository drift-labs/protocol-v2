use crate::controller::position::PositionDirection;
use crate::error::DriftResult;
use crate::math::casting::Cast;
use crate::math::constants::AUCTION_DERIVE_PRICE_FRACTION;
use crate::math::orders::standardize_price;
use crate::math::safe_math::SafeMath;
use crate::state::oracle::OraclePriceData;
use crate::state::user::Order;

use std::cmp::min;

#[cfg(test)]
mod tests;

pub fn calculate_auction_prices(
    oracle_price_data: &OraclePriceData,
    direction: PositionDirection,
    limit_price: u64,
) -> DriftResult<(u64, u64)> {
    let oracle_price = oracle_price_data.price.cast::<u64>()?;
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

pub fn calculate_auction_price(order: &Order, slot: u64, tick_size: u64) -> DriftResult<u64> {
    let slots_elapsed = slot.safe_sub(order.slot)?;

    let delta_numerator = min(slots_elapsed, order.auction_duration.cast()?);
    let delta_denominator = order.auction_duration;

    if delta_denominator == 0 {
        return Ok(order.auction_end_price);
    }

    let price_delta = match order.direction {
        PositionDirection::Long => order
            .auction_end_price
            .safe_sub(order.auction_start_price)?
            .safe_mul(delta_numerator.cast()?)?
            .safe_div(delta_denominator.cast()?)?,
        PositionDirection::Short => order
            .auction_start_price
            .safe_sub(order.auction_end_price)?
            .safe_mul(delta_numerator.cast()?)?
            .safe_div(delta_denominator.cast()?)?,
    };

    let price = match order.direction {
        PositionDirection::Long => order.auction_start_price.safe_add(price_delta)?,
        PositionDirection::Short => order.auction_start_price.safe_sub(price_delta)?,
    };

    standardize_price(price, tick_size, order.direction)
}

pub fn does_auction_satisfy_maker_order(
    maker_order: &Order,
    taker_order: &Order,
    auction_price: u64,
) -> bool {
    // TODO more conditions to check?
    if maker_order.direction == taker_order.direction
        || maker_order.market_index != taker_order.market_index
    {
        return false;
    }

    match maker_order.direction {
        PositionDirection::Long => auction_price <= maker_order.price,
        PositionDirection::Short => auction_price >= maker_order.price,
    }
}

pub fn is_auction_complete(order_slot: u64, auction_duration: u8, slot: u64) -> DriftResult<bool> {
    if auction_duration == 0 {
        return Ok(true);
    }

    let slots_elapsed = slot.safe_sub(order_slot)?;

    Ok(slots_elapsed > auction_duration.cast()?)
}
