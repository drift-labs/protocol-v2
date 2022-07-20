use crate::controller::amm::{calculate_base_swap_output_with_spread, SwapDirection};
use crate::controller::position::PositionDirection;
use crate::error::ClearingHouseResult;
use crate::math::amm::{calculate_price, calculate_spread_reserves};
use crate::math::casting::cast;
use crate::math::constants::MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO;
use crate::math::position::calculate_entry_price;
use crate::math_error;
use crate::state::market::Market;
use crate::state::user::Order;
use solana_program::msg;
use std::cmp::min;

/// for bid (direction == Long), the auction start price is based on the bid reserves
/// for ask (direction == Short), the auction start price is based on the ask reserves
pub fn calculate_auction_start_price(
    market: &Market,
    direction: PositionDirection,
) -> ClearingHouseResult<u128> {
    let (base_asset_reserves, quote_asset_reserves) = calculate_spread_reserves(
        &market.amm,
        match direction {
            PositionDirection::Long => PositionDirection::Short,
            PositionDirection::Short => PositionDirection::Long,
        },
    )?;

    let auction_start_price = calculate_price(
        base_asset_reserves,
        quote_asset_reserves,
        market.amm.peg_multiplier,
    )?;

    Ok(auction_start_price)
}

pub fn calculate_auction_end_price(
    market: &Market,
    direction: PositionDirection,
    base_asset_amount: u128,
) -> ClearingHouseResult<u128> {
    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Remove,
        PositionDirection::Short => SwapDirection::Add,
    };

    let (_, _, quote_asset_amount, _) =
        calculate_base_swap_output_with_spread(&market.amm, base_asset_amount, swap_direction)?;

    let auction_end_price = calculate_entry_price(quote_asset_amount, base_asset_amount)?;

    Ok(auction_end_price)
}

pub fn calculate_auction_price(order: &Order, slot: u64) -> ClearingHouseResult<u128> {
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

    Ok(price)
}

pub fn does_auction_satisfy_maker_order(
    maker_order: &Order,
    taker_order: &Order,
    auction_price: u128,
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

pub fn calculate_auction_fill_amount(
    auction_price: u128,
    maker_order: &Order,
    taker_order: &Order,
) -> ClearingHouseResult<(u128, u128)> {
    let maker_base_asset_amount_unfilled = maker_order
        .base_asset_amount
        .checked_sub(maker_order.base_asset_amount_filled)
        .ok_or_else(math_error!())?;

    let taker_base_asset_amount_unfilled = taker_order
        .base_asset_amount
        .checked_sub(taker_order.base_asset_amount_filled)
        .ok_or_else(math_error!())?;

    let base_asset_amount_to_fill = min(
        taker_base_asset_amount_unfilled,
        maker_base_asset_amount_unfilled,
    );

    // TODO: should round up taker/maker quote asset amount based on who is going long/short
    let quote_asset_amount = base_asset_amount_to_fill
        .checked_mul(auction_price)
        .ok_or_else(math_error!())?
        .checked_div(MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO)
        .ok_or_else(math_error!())?;

    Ok((base_asset_amount_to_fill, quote_asset_amount))
}

pub fn is_auction_complete(
    order_slot: u64,
    auction_duration: u8,
    slot: u64,
) -> ClearingHouseResult<bool> {
    let time_elapsed = slot.checked_sub(order_slot).ok_or_else(math_error!())?;

    Ok(time_elapsed >= cast(auction_duration)?)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION, MARK_PRICE_PRECISION, QUOTE_PRECISION,
    };

    #[test]
    fn maker_order_fills_entire_taker_order() {
        let auction_price = 10 * MARK_PRICE_PRECISION;
        let taker_order = Order {
            base_asset_amount: 2 * BASE_PRECISION,
            ..Order::default()
        };

        let maker_order = Order {
            base_asset_amount: 2 * BASE_PRECISION,
            ..Order::default()
        };

        let (base_asset_amount, quote_asset_amount) =
            calculate_auction_fill_amount(auction_price, &maker_order, &taker_order).unwrap();

        let expected_base_asset_amount = 2 * AMM_RESERVE_PRECISION;
        assert_eq!(base_asset_amount, expected_base_asset_amount);

        let expected_quote_asset_amount = 20 * QUOTE_PRECISION;
        assert_eq!(quote_asset_amount, expected_quote_asset_amount);
    }

    #[test]
    fn maker_order_fills_portion_taker_order() {
        let auction_price = 10 * MARK_PRICE_PRECISION;
        let taker_order = Order {
            base_asset_amount: 2 * BASE_PRECISION,
            ..Order::default()
        };

        let maker_order = Order {
            base_asset_amount: BASE_PRECISION,
            ..Order::default()
        };

        let (base_asset_amount, quote_asset_amount) =
            calculate_auction_fill_amount(auction_price, &maker_order, &taker_order).unwrap();

        let expected_base_asset_amount = AMM_RESERVE_PRECISION;
        assert_eq!(base_asset_amount, expected_base_asset_amount);

        let expected_quote_asset_amount = 10 * QUOTE_PRECISION;
        assert_eq!(quote_asset_amount, expected_quote_asset_amount);
    }

    #[test]
    fn portion_of_maker_order_fills_taker_order() {
        let auction_price = 10 * MARK_PRICE_PRECISION;
        let taker_order = Order {
            base_asset_amount: BASE_PRECISION,
            ..Order::default()
        };

        let maker_order = Order {
            base_asset_amount: 2 * BASE_PRECISION,
            ..Order::default()
        };

        let (base_asset_amount, quote_asset_amount) =
            calculate_auction_fill_amount(auction_price, &maker_order, &taker_order).unwrap();

        let expected_base_asset_amount = AMM_RESERVE_PRECISION;
        assert_eq!(base_asset_amount, expected_base_asset_amount);

        let expected_quote_asset_amount = 10 * QUOTE_PRECISION;
        assert_eq!(quote_asset_amount, expected_quote_asset_amount);
    }
}
