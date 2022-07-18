use std::cmp::min;
use std::ops::Div;

use solana_program::msg;

use crate::controller::amm::SwapDirection;
use crate::controller::position::PositionDelta;
use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math;
use crate::math::casting::{cast_to_i128, cast_to_u128};
use crate::math::constants::MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO;
use crate::math::position::calculate_entry_price;
use crate::math_error;
use crate::state::market::Market;
use crate::state::user::{Order, OrderTriggerCondition, OrderType};

pub fn calculate_base_asset_amount_market_can_execute(
    order: &Order,
    market: &Market,
    precomputed_mark_price: Option<u128>,
    valid_oracle_price: Option<i128>,
    slot: u64,
) -> ClearingHouseResult<u128> {
    match order.order_type {
        OrderType::Limit => {
            calculate_base_asset_amount_to_trade_for_limit(order, market, valid_oracle_price, slot)
        }
        OrderType::TriggerMarket => calculate_base_asset_amount_to_trade_for_trigger_market(
            order,
            market,
            precomputed_mark_price,
            valid_oracle_price,
        ),
        OrderType::TriggerLimit => calculate_base_asset_amount_to_trade_for_trigger_limit(
            order,
            market,
            precomputed_mark_price,
            valid_oracle_price,
            slot,
        ),
        OrderType::Market => Err(ErrorCode::InvalidOrder),
    }
}

pub fn calculate_base_asset_amount_to_trade_for_limit(
    order: &Order,
    market: &Market,
    valid_oracle_price: Option<i128>,
    slot: u64,
) -> ClearingHouseResult<u128> {
    let base_asset_amount_to_fill = order
        .base_asset_amount
        .checked_sub(order.base_asset_amount_filled)
        .ok_or_else(math_error!())?;

    let limit_price = order.get_limit_price(valid_oracle_price, slot)?;

    let (max_trade_base_asset_amount, max_trade_direction) =
        math::amm::calculate_max_base_asset_amount_to_trade(
            &market.amm,
            limit_price,
            order.direction,
        )?;
    if max_trade_direction != order.direction || max_trade_base_asset_amount == 0 {
        return Ok(0);
    }

    standardize_base_asset_amount(
        min(base_asset_amount_to_fill, max_trade_base_asset_amount),
        market.amm.base_asset_amount_step_size,
    )
}

fn calculate_base_asset_amount_to_trade_for_trigger_market(
    order: &Order,
    market: &Market,
    precomputed_mark_price: Option<u128>,
    valid_oracle_price: Option<i128>,
) -> ClearingHouseResult<u128> {
    let mark_price = match precomputed_mark_price {
        Some(mark_price) => mark_price,
        None => market.amm.mark_price()?,
    };

    match order.trigger_condition {
        OrderTriggerCondition::Above => {
            if mark_price <= order.trigger_price {
                return Ok(0);
            }

            // If there is a valid oracle, check that trigger condition is also satisfied by
            // oracle price (plus some additional buffer)
            if let Some(oracle_price) = valid_oracle_price {
                let oracle_price_101pct = oracle_price
                    .checked_mul(101)
                    .ok_or_else(math_error!())?
                    .checked_div(100)
                    .ok_or_else(math_error!())?;

                if cast_to_u128(oracle_price_101pct)? <= order.trigger_price {
                    return Ok(0);
                }
            }
        }
        OrderTriggerCondition::Below => {
            if mark_price >= order.trigger_price {
                return Ok(0);
            }

            // If there is a valid oracle, check that trigger condition is also satisfied by
            // oracle price (plus some additional buffer)
            if let Some(oracle_price) = valid_oracle_price {
                let oracle_price_99pct = oracle_price
                    .checked_mul(99)
                    .ok_or_else(math_error!())?
                    .checked_div(100)
                    .ok_or_else(math_error!())?;

                if cast_to_u128(oracle_price_99pct)? >= order.trigger_price {
                    return Ok(0);
                }
            }
        }
    }

    standardize_base_asset_amount(
        order
            .base_asset_amount
            .checked_sub(order.base_asset_amount_filled)
            .ok_or_else(math_error!())?,
        market.amm.base_asset_amount_step_size,
    )
}

fn calculate_base_asset_amount_to_trade_for_trigger_limit(
    order: &Order,
    market: &Market,
    precomputed_mark_price: Option<u128>,
    valid_oracle_price: Option<i128>,
    slot: u64,
) -> ClearingHouseResult<u128> {
    // if the order has not been filled yet, need to check that trigger condition is met
    if order.base_asset_amount_filled == 0 {
        let base_asset_amount = calculate_base_asset_amount_to_trade_for_trigger_market(
            order,
            market,
            precomputed_mark_price,
            valid_oracle_price,
        )?;
        if base_asset_amount == 0 {
            return Ok(0);
        }
    }

    calculate_base_asset_amount_to_trade_for_limit(order, market, None, slot)
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

pub fn get_position_delta_for_fill(
    base_asset_amount: u128,
    quote_asset_amount: u128,
    direction: PositionDirection,
) -> ClearingHouseResult<PositionDelta> {
    Ok(PositionDelta {
        quote_asset_amount,
        base_asset_amount: match direction {
            PositionDirection::Long => cast_to_i128(base_asset_amount)?,
            PositionDirection::Short => -cast_to_i128(base_asset_amount)?,
        },
    })
}

pub fn order_breaches_oracle_price_limits(
    order: &Order,
    oracle_price: i128,
    slot: u64,
) -> ClearingHouseResult<bool> {
    let order_limit_price = order.get_limit_price(Some(oracle_price), slot)?;
    let oracle_price = oracle_price.unsigned_abs();

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
            Ok(ratio <= 40)
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
            Ok(ratio <= 40)
        }
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
