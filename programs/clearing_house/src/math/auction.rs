use crate::controller::position::PositionDirection;
use crate::error::ClearingHouseResult;
use crate::math::casting::{cast, Cast};
use crate::math::constants::AUCTION_DERIVE_PRICE_FRACTION;
use crate::math::orders::standardize_price;
use crate::math_error;
use crate::state::oracle::OraclePriceData;
use crate::state::user::Order;
use solana_program::msg;
use std::cmp::min;

#[cfg(test)]
mod tests;

pub fn calculate_auction_prices(
    oracle_price_data: &OraclePriceData,
    direction: PositionDirection,
    limit_price: u64,
) -> ClearingHouseResult<(u64, u64)> {
    let oracle_price = oracle_price_data.price.cast::<u64>()?;
    if limit_price > 0 {
        let (auction_start_price, auction_end_price) = match direction {
            // Long and limit price is better than oracle price
            PositionDirection::Long if limit_price < oracle_price => {
                let limit_derive_start_price = limit_price
                    .checked_sub(limit_price / AUCTION_DERIVE_PRICE_FRACTION)
                    .ok_or_else(math_error!())?;
                let oracle_derive_start_price = oracle_price
                    .checked_sub(oracle_price / AUCTION_DERIVE_PRICE_FRACTION)
                    .ok_or_else(math_error!())?;

                (
                    limit_derive_start_price.min(oracle_derive_start_price),
                    limit_price,
                )
            }
            // Long and limit price is worse than oracle price
            PositionDirection::Long if limit_price >= oracle_price => {
                let oracle_derive_end_price = oracle_price
                    .checked_add(oracle_price / AUCTION_DERIVE_PRICE_FRACTION)
                    .ok_or_else(math_error!())?;

                (oracle_price, limit_price.min(oracle_derive_end_price))
            }
            // Short and limit price is better than oracle price
            PositionDirection::Short if limit_price > oracle_price => {
                let limit_derive_start_price = limit_price
                    .checked_add(limit_price / AUCTION_DERIVE_PRICE_FRACTION)
                    .ok_or_else(math_error!())?;
                let oracle_derive_start_price = oracle_price
                    .checked_add(oracle_price / AUCTION_DERIVE_PRICE_FRACTION)
                    .ok_or_else(math_error!())?;

                (
                    limit_derive_start_price.max(oracle_derive_start_price),
                    limit_price,
                )
            }
            // Short and limit price is worse than oracle price
            PositionDirection::Short if limit_price <= oracle_price => {
                let oracle_derive_end_price = oracle_price
                    .checked_sub(oracle_price / AUCTION_DERIVE_PRICE_FRACTION)
                    .ok_or_else(math_error!())?;

                (oracle_price, limit_price.max(oracle_derive_end_price))
            }
            _ => unreachable!(),
        };

        return Ok((auction_start_price, auction_end_price));
    }

    let auction_end_price = match direction {
        PositionDirection::Long => oracle_price
            .checked_add(oracle_price / AUCTION_DERIVE_PRICE_FRACTION)
            .ok_or_else(math_error!())?,
        PositionDirection::Short => oracle_price
            .checked_sub(oracle_price / AUCTION_DERIVE_PRICE_FRACTION)
            .ok_or_else(math_error!())?,
    };

    Ok((oracle_price, auction_end_price))
}

pub fn calculate_auction_price(
    order: &Order,
    slot: u64,
    tick_size: u64,
) -> ClearingHouseResult<u64> {
    let slots_elapsed = slot.checked_sub(order.slot).ok_or_else(math_error!())?;

    let delta_numerator = min(slots_elapsed, cast(order.auction_duration)?);
    let delta_denominator = order.auction_duration;

    if delta_denominator == 0 {
        return Ok(order.auction_end_price);
    }

    let price_delta = match order.direction {
        PositionDirection::Long => order
            .auction_end_price
            .checked_sub(order.auction_start_price)
            .ok_or_else(math_error!())?
            .checked_mul(cast(delta_numerator)?)
            .ok_or_else(math_error!())?
            .checked_div(cast(delta_denominator)?)
            .ok_or_else(math_error!())?,
        PositionDirection::Short => order
            .auction_start_price
            .checked_sub(order.auction_end_price)
            .ok_or_else(math_error!())?
            .checked_mul(cast(delta_numerator)?)
            .ok_or_else(math_error!())?
            .checked_div(cast(delta_denominator)?)
            .ok_or_else(math_error!())?,
    };

    let price = match order.direction {
        PositionDirection::Long => order
            .auction_start_price
            .checked_add(price_delta)
            .ok_or_else(math_error!())?,
        PositionDirection::Short => order
            .auction_start_price
            .checked_sub(price_delta)
            .ok_or_else(math_error!())?,
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

pub fn is_auction_complete(
    order_slot: u64,
    auction_duration: u8,
    slot: u64,
) -> ClearingHouseResult<bool> {
    if auction_duration == 0 {
        return Ok(true);
    }

    let slots_elapsed = slot.checked_sub(order_slot).ok_or_else(math_error!())?;

    Ok(slots_elapsed > cast(auction_duration)?)
}
