use std::cmp::min;
use std::ops::Div;

use solana_program::msg;

use crate::controller::amm::SwapDirection;
use crate::controller::position::PositionDelta;
use crate::controller::position::PositionDirection;
use crate::error::ClearingHouseResult;
use crate::math;
use crate::math::amm::calculate_max_base_asset_amount_fillable;
use crate::math::auction::is_auction_complete;
use crate::math::casting::{cast, cast_to_i128};
use crate::math::constants::{MARGIN_PRECISION, MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO};
use crate::math::position::calculate_entry_price;
use crate::math_error;
use crate::state::market::Market;
use crate::state::user::{Order, OrderStatus, OrderTriggerCondition, OrderType, User};

pub fn calculate_base_asset_amount_for_amm_to_fulfill(
    order: &Order,
    market: &Market,
    valid_oracle_price: Option<i128>,
    slot: u64,
) -> ClearingHouseResult<u128> {
    if order.must_be_triggered() && !order.triggered {
        return Ok(0);
    }

    let limit_price = order.get_limit_price(&market.amm, valid_oracle_price, slot)?;
    let base_asset_amount =
        calculate_base_asset_amount_to_fill_up_to_limit_price(order, market, limit_price)?;
    let max_base_asset_amount = calculate_max_base_asset_amount_fillable(&market.amm)?;

    let base_asset_amount = min(base_asset_amount, max_base_asset_amount);

    Ok(base_asset_amount)
}

pub fn calculate_base_asset_amount_to_fill_up_to_limit_price(
    order: &Order,
    market: &Market,
    limit_price: u128,
) -> ClearingHouseResult<u128> {
    let base_asset_amount_unfilled = order.get_base_asset_amount_unfilled()?;

    let (max_trade_base_asset_amount, max_trade_direction) =
        math::amm::calculate_base_asset_amount_to_trade_to_price(
            &market.amm,
            limit_price,
            order.direction,
        )?;

    if max_trade_direction != order.direction || max_trade_base_asset_amount == 0 {
        return Ok(0);
    }

    standardize_base_asset_amount(
        min(base_asset_amount_unfilled, max_trade_base_asset_amount),
        market.amm.base_asset_amount_step_size,
    )
}

pub fn limit_price_satisfied(
    limit_price: u128,
    quote_asset_amount: u128,
    base_asset_amount: u128,
    direction: PositionDirection,
) -> ClearingHouseResult<bool> {
    let price = calculate_entry_price(quote_asset_amount, base_asset_amount)?;

    match direction {
        PositionDirection::Long => {
            if price > limit_price {
                return Ok(false);
            }
        }
        PositionDirection::Short => {
            if price < limit_price {
                return Ok(false);
            }
        }
    }

    Ok(true)
}

pub fn calculate_quote_asset_amount_for_maker_order(
    base_asset_amount: u128,
    limit_price: u128,
    swap_direction: SwapDirection,
) -> ClearingHouseResult<u128> {
    let mut quote_asset_amount = base_asset_amount
        .checked_mul(limit_price)
        .ok_or_else(math_error!())?
        .div(MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO);

    // when a user goes long base asset, make the base asset slightly more expensive
    // by adding one unit of quote asset
    if swap_direction == SwapDirection::Remove {
        quote_asset_amount = quote_asset_amount
            .checked_add(1)
            .ok_or_else(math_error!())?;
    }

    Ok(quote_asset_amount)
}

pub fn calculate_base_asset_amount_for_reduce_only_order(
    proposed_base_asset_amount: u128,
    order_direction: PositionDirection,
    existing_position: i128,
) -> u128 {
    if (order_direction == PositionDirection::Long && existing_position >= 0)
        || (order_direction == PositionDirection::Short && existing_position <= 0)
    {
        msg!("Reduce only order can not reduce position");
        0
    } else {
        min(proposed_base_asset_amount, existing_position.unsigned_abs())
    }
}

pub fn standardize_base_asset_amount(
    base_asset_amount: u128,
    step_size: u128,
) -> ClearingHouseResult<u128> {
    let remainder = base_asset_amount
        .checked_rem_euclid(step_size)
        .ok_or_else(math_error!())?;

    base_asset_amount
        .checked_sub(remainder)
        .ok_or_else(math_error!())
}

pub fn standardize_base_asset_amount_ceil(
    base_asset_amount: u128,
    step_size: u128,
) -> ClearingHouseResult<u128> {
    let remainder = base_asset_amount
        .checked_rem_euclid(step_size)
        .ok_or_else(math_error!())?;

    if remainder == 0 {
        Ok(base_asset_amount)
    } else {
        base_asset_amount
            .checked_add(step_size)
            .ok_or_else(math_error!())?
            .checked_sub(remainder)
            .ok_or_else(math_error!())
    }
}

pub fn get_position_delta_for_fill(
    base_asset_amount: u128,
    quote_asset_amount: u128,
    direction: PositionDirection,
) -> ClearingHouseResult<PositionDelta> {
    Ok(PositionDelta {
        quote_asset_amount: match direction {
            PositionDirection::Long => -cast_to_i128(quote_asset_amount)?,
            PositionDirection::Short => cast_to_i128(quote_asset_amount)?,
        },
        base_asset_amount: match direction {
            PositionDirection::Long => cast_to_i128(base_asset_amount)?,
            PositionDirection::Short => -cast_to_i128(base_asset_amount)?,
        },
    })
}

pub fn should_cancel_order_after_fulfill(
    user: &User,
    user_order_index: usize,
    slot: u64,
) -> ClearingHouseResult<bool> {
    let order = &user.orders[user_order_index];
    if order.order_type != OrderType::Market || order.status != OrderStatus::Open {
        return Ok(false);
    }

    Ok(order.price != 0 && is_auction_complete(order.slot, order.auction_duration, slot)?)
}

pub fn should_expire_order(
    user: &User,
    user_order_index: usize,
    slot: u64,
    max_auction_duration: u8,
) -> ClearingHouseResult<bool> {
    let order = &user.orders[user_order_index];
    if order.order_type != OrderType::Market || order.status != OrderStatus::Open {
        return Ok(false);
    }

    let slots_elapsed = slot.checked_sub(order.slot).ok_or_else(math_error!())?;
    Ok(slots_elapsed > cast(max_auction_duration)?)
}

pub fn order_breaches_oracle_price_limits(
    market: &Market,
    order: &Order,
    oracle_price: i128,
    slot: u64,
) -> ClearingHouseResult<bool> {
    let order_limit_price = order.get_limit_price(&market.amm, Some(oracle_price), slot)?;
    let oracle_price = oracle_price.unsigned_abs();

    let max_ratio = MARGIN_PRECISION / (market.margin_ratio_initial as u128 / 2);
    match order.direction {
        PositionDirection::Long => {
            if order_limit_price <= oracle_price {
                return Ok(false);
            }

            let ratio = order_limit_price
                .checked_div(
                    order_limit_price
                        .checked_sub(oracle_price)
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?;

            // order cant be buying if oracle price is more than 2.5% below limit price
            Ok(ratio <= max_ratio)
        }
        PositionDirection::Short => {
            if order_limit_price >= oracle_price {
                return Ok(false);
            }

            let ratio = oracle_price
                .checked_div(
                    oracle_price
                        .checked_sub(order_limit_price)
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?;

            // order cant be buying if oracle price is more than 2.5% above limit price
            Ok(ratio <= max_ratio)
        }
    }
}

pub fn order_satisfies_trigger_condition(order: &Order, oracle_price: u128) -> bool {
    match order.trigger_condition {
        OrderTriggerCondition::Above => oracle_price > order.trigger_price,
        OrderTriggerCondition::Below => oracle_price < order.trigger_price,
    }
}

#[cfg(test)]
mod test {

    pub mod standardize_base_asset_amount {
        use crate::math::orders::standardize_base_asset_amount;

        #[test]
        fn remainder_less_than_half_minimum_size() {
            let base_asset_amount: u128 = 200001;
            let minimum_size: u128 = 100000;

            let result = standardize_base_asset_amount(base_asset_amount, minimum_size).unwrap();

            assert_eq!(result, 200000);
        }

        #[test]
        fn remainder_more_than_half_minimum_size() {
            let base_asset_amount: u128 = 250001;
            let minimum_size: u128 = 100000;

            let result = standardize_base_asset_amount(base_asset_amount, minimum_size).unwrap();

            assert_eq!(result, 200000);
        }

        #[test]
        fn zero() {
            let base_asset_amount: u128 = 0;
            let minimum_size: u128 = 100000;

            let result = standardize_base_asset_amount(base_asset_amount, minimum_size).unwrap();

            assert_eq!(result, 0);
        }
    }
}
