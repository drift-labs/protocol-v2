use std::cmp::min;
use std::ops::Div;

use crate::validate;
use solana_program::msg;

use crate::controller::position::PositionDelta;
use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math;
use crate::math::amm::calculate_max_base_asset_amount_fillable;
use crate::math::auction::is_auction_complete;
use crate::math::casting::Cast;
use crate::math::constants::{BASE_PRECISION, MARGIN_PRECISION};
use crate::math::position::calculate_entry_price;

use crate::math_error;
use crate::state::market::{PerpMarket, AMM};

use crate::math::ceil_div::CheckedCeilDiv;
use crate::state::spot_market::SpotBalanceType;
use crate::state::user::{Order, OrderStatus, OrderTriggerCondition, OrderType, User};

pub fn calculate_base_asset_amount_for_amm_to_fulfill(
    order: &Order,
    market: &PerpMarket,
    valid_oracle_price: Option<i128>,
    slot: u64,
    override_limit_price: Option<u128>,
) -> ClearingHouseResult<(u64, u128)> {
    let limit_price = if let Some(override_limit_price) = override_limit_price {
        let order_limit_price = order.get_limit_price(
            valid_oracle_price,
            slot,
            market.amm.order_tick_size,
            Some(&market.amm),
        )?;

        validate!(
            (order_limit_price >= override_limit_price
                && order.direction == PositionDirection::Long)
                || (order_limit_price <= override_limit_price
                    && order.direction == PositionDirection::Short),
            ErrorCode::DefaultError,
            "override_limit_price not better than order's limit price"
        )?;

        override_limit_price
    } else {
        order.get_limit_price(
            valid_oracle_price,
            slot,
            market.amm.order_tick_size,
            Some(&market.amm),
        )?
    };

    if order.must_be_triggered() && !order.triggered {
        return Ok((0, limit_price));
    }

    let base_asset_amount =
        calculate_base_asset_amount_to_fill_up_to_limit_price(order, market, limit_price)?;
    let max_base_asset_amount =
        calculate_max_base_asset_amount_fillable(&market.amm, &order.direction)?;

    Ok((min(base_asset_amount, max_base_asset_amount), limit_price))
}

pub fn calculate_base_asset_amount_to_fill_up_to_limit_price(
    order: &Order,
    market: &PerpMarket,
    limit_price: u128,
) -> ClearingHouseResult<u64> {
    let base_asset_amount_unfilled = order.get_base_asset_amount_unfilled()?;

    let (max_trade_base_asset_amount, max_trade_direction) =
        math::amm_spread::calculate_base_asset_amount_to_trade_to_price(
            &market.amm,
            limit_price,
            order.direction,
        )?;

    if max_trade_direction != order.direction || max_trade_base_asset_amount == 0 {
        return Ok(0);
    }

    standardize_base_asset_amount(
        min(base_asset_amount_unfilled, max_trade_base_asset_amount),
        market.amm.order_step_size,
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
    base_asset_amount: u64,
    fill_price: u128,
    base_decimals: u32,
    position_direction: PositionDirection,
) -> ClearingHouseResult<u64> {
    let precision_decrease = 10_u128.pow(base_decimals);

    match position_direction {
        PositionDirection::Long => fill_price
            .checked_mul(base_asset_amount.cast()?)
            .ok_or_else(math_error!())?
            .div(precision_decrease)
            .cast::<u64>(),
        PositionDirection::Short => fill_price
            .checked_mul(base_asset_amount.cast()?)
            .ok_or_else(math_error!())?
            .checked_ceil_div(precision_decrease)
            .ok_or_else(math_error!())?
            .cast::<u64>(),
    }
}

pub fn calculate_base_asset_amount_for_reduce_only_order(
    proposed_base_asset_amount: u64,
    order_direction: PositionDirection,
    existing_position: i64,
) -> ClearingHouseResult<u64> {
    if proposed_base_asset_amount > 0
        && (order_direction == PositionDirection::Long && existing_position >= 0)
        || (order_direction == PositionDirection::Short && existing_position <= 0)
    {
        msg!("Reduce Only Order must decrease existing position size");
        Err(ErrorCode::InvalidOrder)
    } else {
        Ok(min(
            proposed_base_asset_amount,
            existing_position.unsigned_abs(),
        ))
    }
}

pub fn standardize_base_asset_amount_with_remainder_i128(
    base_asset_amount: i128,
    step_size: u128,
) -> ClearingHouseResult<(i128, i128)> {
    let remainder = base_asset_amount
        .unsigned_abs()
        .checked_rem_euclid(step_size)
        .ok_or_else(math_error!())?
        .cast::<i128>()?
        .checked_mul(base_asset_amount.signum())
        .ok_or_else(math_error!())?;

    let standardized_base_asset_amount = base_asset_amount
        .checked_sub(remainder)
        .ok_or_else(math_error!())?;

    Ok((standardized_base_asset_amount, remainder))
}

pub fn standardize_base_asset_amount(
    base_asset_amount: u64,
    step_size: u64,
) -> ClearingHouseResult<u64> {
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

pub fn is_multiple_of_step_size(
    base_asset_amount: u64,
    step_size: u64,
) -> ClearingHouseResult<bool> {
    let remainder = base_asset_amount
        .checked_rem_euclid(step_size)
        .ok_or_else(math_error!())?;

    Ok(remainder == 0)
}

pub fn standardize_price(
    price: u64,
    tick_size: u64,
    direction: PositionDirection,
) -> ClearingHouseResult<u64> {
    let remainder = price
        .checked_rem_euclid(tick_size)
        .ok_or_else(math_error!())?;

    if remainder == 0 {
        return Ok(price);
    }

    match direction {
        PositionDirection::Long => price.checked_sub(remainder).ok_or_else(math_error!()),
        PositionDirection::Short => price
            .checked_add(tick_size)
            .ok_or_else(math_error!())?
            .checked_sub(remainder)
            .ok_or_else(math_error!()),
    }
}

pub fn get_position_delta_for_fill(
    base_asset_amount: u64,
    quote_asset_amount: u64,
    direction: PositionDirection,
) -> ClearingHouseResult<PositionDelta> {
    Ok(PositionDelta {
        quote_asset_amount: match direction {
            PositionDirection::Long => -quote_asset_amount.cast()?,
            PositionDirection::Short => quote_asset_amount.cast()?,
        },
        base_asset_amount: match direction {
            PositionDirection::Long => base_asset_amount.cast()?,
            PositionDirection::Short => -base_asset_amount.cast()?,
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
) -> ClearingHouseResult<bool> {
    let order = &user.orders[user_order_index];
    if order.status != OrderStatus::Open
        || order.time_in_force == 0
        || matches!(
            order.order_type,
            OrderType::TriggerMarket | OrderType::TriggerLimit
        )
    {
        return Ok(false);
    }

    let slots_elapsed = slot.checked_sub(order.slot).ok_or_else(math_error!())?;
    Ok(slots_elapsed > order.time_in_force.cast()?)
}

pub fn order_breaches_oracle_price_limits(
    order: &Order,
    oracle_price: i128,
    slot: u64,
    tick_size: u64,
    margin_ratio_initial: u128,
    margin_ratio_maintenance: u128,
    amm: Option<&AMM>,
) -> ClearingHouseResult<bool> {
    let order_limit_price = order.get_limit_price(Some(oracle_price), slot, tick_size, amm)?;
    let oracle_price = oracle_price.unsigned_abs();

    let max_percent_diff = margin_ratio_initial
        .checked_sub(margin_ratio_maintenance)
        .ok_or_else(math_error!())?;

    match order.direction {
        PositionDirection::Long => {
            if order_limit_price <= oracle_price {
                return Ok(false);
            }

            let percent_diff = order_limit_price
                .checked_sub(oracle_price)
                .ok_or_else(math_error!())?
                .checked_mul(MARGIN_PRECISION)
                .ok_or_else(math_error!())?
                .checked_div(oracle_price)
                .ok_or_else(math_error!())?;

            if percent_diff >= max_percent_diff {
                // order cant be buying if oracle price is more than 5% below limit price
                msg!(
                    "Limit Price Breaches Oracle for Long: {} >> {}",
                    order_limit_price,
                    oracle_price
                );
                return Ok(true);
            }

            Ok(false)
        }
        PositionDirection::Short => {
            if order_limit_price >= oracle_price {
                return Ok(false);
            }

            let percent_diff = oracle_price
                .checked_sub(order_limit_price)
                .ok_or_else(math_error!())?
                .checked_mul(MARGIN_PRECISION)
                .ok_or_else(math_error!())?
                .checked_div(oracle_price)
                .ok_or_else(math_error!())?;

            if percent_diff >= max_percent_diff {
                // order cant be selling if oracle price is more than 5% above limit price
                msg!(
                    "Limit Price Breaches Oracle for Short: {} << {}",
                    order_limit_price,
                    oracle_price
                );
                return Ok(true);
            }

            Ok(false)
        }
    }
}

pub fn order_satisfies_trigger_condition(order: &Order, oracle_price: u64) -> bool {
    match order.trigger_condition {
        OrderTriggerCondition::Above => oracle_price > order.trigger_price,
        OrderTriggerCondition::Below => oracle_price < order.trigger_price,
    }
}

pub fn is_spot_order_risk_decreasing(
    order: &Order,
    balance_type: &SpotBalanceType,
    token_amount: u128,
) -> ClearingHouseResult<bool> {
    let risk_decreasing = match (balance_type, order.direction) {
        (SpotBalanceType::Deposit, PositionDirection::Short) => {
            (order.base_asset_amount as u128)
                < token_amount.checked_mul(2).ok_or_else(math_error!())?
        }
        (SpotBalanceType::Borrow, PositionDirection::Long) => {
            (order.base_asset_amount as u128)
                < token_amount.checked_mul(2).ok_or_else(math_error!())?
        }
        (_, _) => false,
    };

    Ok(risk_decreasing)
}

pub fn is_spot_order_risk_increasing(
    order: &Order,
    balance_type: &SpotBalanceType,
    token_amount: u128,
) -> ClearingHouseResult<bool> {
    is_spot_order_risk_decreasing(order, balance_type, token_amount)
        .map(|risk_decreasing| !risk_decreasing)
}

pub fn is_order_risk_decreasing(
    order_direction: &PositionDirection,
    order_base_asset_amount: u64,
    position_base_asset_amount: i64,
) -> ClearingHouseResult<bool> {
    Ok(match order_direction {
        // User is short and order is long
        PositionDirection::Long if position_base_asset_amount < 0 => {
            order_base_asset_amount
                < position_base_asset_amount
                    .unsigned_abs()
                    .checked_mul(2)
                    .ok_or_else(math_error!())?
        }
        // User is long and order is short
        PositionDirection::Short if position_base_asset_amount > 0 => {
            order_base_asset_amount
                < position_base_asset_amount
                    .unsigned_abs()
                    .checked_mul(2)
                    .ok_or_else(math_error!())?
        }
        _ => false,
    })
}

pub fn is_order_risk_increasing(
    order_direction: &PositionDirection,
    order_base_asset_amount: u64,
    position_base_asset_amount: i64,
) -> ClearingHouseResult<bool> {
    is_order_risk_decreasing(
        order_direction,
        order_base_asset_amount,
        position_base_asset_amount,
    )
    .map(|risk_decreasing| !risk_decreasing)
}

pub fn validate_fill_price(
    quote_asset_amount: u64,
    base_asset_amount: u64,
    order_direction: PositionDirection,
    order_limit_price: u128,
    is_taker: bool,
) -> ClearingHouseResult {
    let rounded_quote_asset_amount = if is_taker {
        match order_direction {
            PositionDirection::Long => quote_asset_amount.saturating_sub(1),
            PositionDirection::Short => quote_asset_amount.saturating_add(1),
        }
    } else {
        quote_asset_amount
    };

    let fill_price = rounded_quote_asset_amount
        .cast::<u128>()?
        .checked_mul(BASE_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(base_asset_amount.cast()?)
        .ok_or_else(math_error!())?;

    if order_direction == PositionDirection::Long && fill_price > order_limit_price {
        msg!(
            "long order fill price ({} = {}/{} * 1000) > limit price ({}) is_taker={}",
            fill_price,
            quote_asset_amount,
            base_asset_amount,
            order_limit_price,
            is_taker
        );
        return Err(ErrorCode::DefaultError);
    }

    if order_direction == PositionDirection::Short && fill_price < order_limit_price {
        msg!(
            "short order fill price ({} = {}/{} * 1000) < limit price ({}) is_taker={}",
            fill_price,
            quote_asset_amount,
            base_asset_amount,
            order_limit_price,
            is_taker
        );
        return Err(ErrorCode::DefaultError);
    }

    Ok(())
}
#[cfg(test)]
mod test {
    pub mod standardize_base_asset_amount_with_remainder_i128 {
        use crate::math::orders::standardize_base_asset_amount_with_remainder_i128;

        #[test]
        fn negative_remainder_greater_than_step() {
            let baa = -90;
            let step_size = 50;

            let (s_baa, rem) =
                standardize_base_asset_amount_with_remainder_i128(baa, step_size).unwrap();

            assert_eq!(s_baa, -50); // reduced to 50 short position
            assert_eq!(rem, -40); // 40 short left over
        }

        #[test]
        fn negative_remainder_smaller_than_step() {
            let baa = -20;
            let step_size = 50;

            let (s_baa, rem) =
                standardize_base_asset_amount_with_remainder_i128(baa, step_size).unwrap();

            assert_eq!(s_baa, 0);
            assert_eq!(rem, -20);
        }

        #[test]
        fn positive_remainder_greater_than_step() {
            let baa = 90;
            let step_size = 50;

            let (s_baa, rem) =
                standardize_base_asset_amount_with_remainder_i128(baa, step_size).unwrap();

            assert_eq!(s_baa, 50); // reduced to 50 long position
            assert_eq!(rem, 40); // 40 long left over
        }

        #[test]
        fn positive_remainder_smaller_than_step() {
            let baa = 20;
            let step_size = 50;

            let (s_baa, rem) =
                standardize_base_asset_amount_with_remainder_i128(baa, step_size).unwrap();

            assert_eq!(s_baa, 0);
            assert_eq!(rem, 20);
        }

        #[test]
        fn no_remainder() {
            let baa = 100;
            let step_size = 50;

            let (s_baa, rem) =
                standardize_base_asset_amount_with_remainder_i128(baa, step_size).unwrap();

            assert_eq!(s_baa, 100);
            assert_eq!(rem, 0);
        }
    }
    // baa = -90
    // remainder = -40
    // baa -= remainder (baa = -50)

    // trades +100
    // stepsize of 50
    // amm = 10 lp = 90
    // net_baa = 10
    // market_baa = -10
    // lp burns => metrics_baa: -90
    // standardize => baa = -50 (round down (+40))
    // amm_net_baa = 10 + (-40)
    // amm_baa = 10 + 40 = 50

    pub mod standardize_base_asset_amount {
        use crate::math::orders::standardize_base_asset_amount;

        #[test]
        fn remainder_less_than_half_minimum_size() {
            let base_asset_amount: u64 = 200001;
            let minimum_size: u64 = 100000;

            let result = standardize_base_asset_amount(base_asset_amount, minimum_size).unwrap();

            assert_eq!(result, 200000);
        }

        #[test]
        fn remainder_more_than_half_minimum_size() {
            let base_asset_amount: u64 = 250001;
            let minimum_size: u64 = 100000;

            let result = standardize_base_asset_amount(base_asset_amount, minimum_size).unwrap();

            assert_eq!(result, 200000);
        }

        #[test]
        fn zero() {
            let base_asset_amount: u64 = 0;
            let minimum_size: u64 = 100000;

            let result = standardize_base_asset_amount(base_asset_amount, minimum_size).unwrap();

            assert_eq!(result, 0);
        }
    }

    mod is_order_risk_increase {
        use crate::controller::position::PositionDirection;
        use crate::math::constants::{BASE_PRECISION_I64, BASE_PRECISION_U64};
        use crate::math::orders::is_order_risk_decreasing;

        #[test]
        fn no_position() {
            let order_direction = PositionDirection::Long;
            let order_base_asset_amount = BASE_PRECISION_U64;
            let existing_position = 0;

            let risk_decreasing = is_order_risk_decreasing(
                &order_direction,
                order_base_asset_amount,
                existing_position,
            )
            .unwrap();

            assert!(!risk_decreasing);

            let order_direction = PositionDirection::Short;
            let risk_decreasing = is_order_risk_decreasing(
                &order_direction,
                order_base_asset_amount,
                existing_position,
            )
            .unwrap();

            assert!(!risk_decreasing);
        }

        #[test]
        fn bid() {
            // user long and bid
            let order_direction = PositionDirection::Long;
            let order_base_asset_amount = BASE_PRECISION_U64;
            let existing_position = BASE_PRECISION_I64;
            let risk_decreasing = is_order_risk_decreasing(
                &order_direction,
                order_base_asset_amount,
                existing_position,
            )
            .unwrap();

            assert!(!risk_decreasing);

            // user short and bid < 2 * position
            let existing_position = -BASE_PRECISION_I64;
            let risk_decreasing = is_order_risk_decreasing(
                &order_direction,
                order_base_asset_amount,
                existing_position,
            )
            .unwrap();

            assert!(risk_decreasing);

            // user short and bid = 2 * position
            let existing_position = -BASE_PRECISION_I64 / 2;
            let risk_decreasing = is_order_risk_decreasing(
                &order_direction,
                order_base_asset_amount,
                existing_position,
            )
            .unwrap();

            assert!(!risk_decreasing);
        }

        #[test]
        fn ask() {
            // user short and ask
            let order_direction = PositionDirection::Short;
            let order_base_asset_amount = BASE_PRECISION_U64;
            let existing_position = -BASE_PRECISION_I64;

            let risk_decreasing = is_order_risk_decreasing(
                &order_direction,
                order_base_asset_amount,
                existing_position,
            )
            .unwrap();

            assert!(!risk_decreasing);

            // user long and ask < 2 * position
            let existing_position = BASE_PRECISION_I64;
            let risk_decreasing = is_order_risk_decreasing(
                &order_direction,
                order_base_asset_amount,
                existing_position,
            )
            .unwrap();

            assert!(risk_decreasing);

            // user long and ask = 2 * position
            let existing_position = BASE_PRECISION_I64 / 2;
            let risk_decreasing = is_order_risk_decreasing(
                &order_direction,
                order_base_asset_amount,
                existing_position,
            )
            .unwrap();

            assert!(!risk_decreasing);
        }
    }

    mod order_breaches_oracle_price_limits {
        use crate::controller::position::PositionDirection;
        use crate::math::constants::{MARGIN_PRECISION, PRICE_PRECISION_I128, PRICE_PRECISION_U64};
        use crate::math::orders::order_breaches_oracle_price_limits;
        use crate::state::market::PerpMarket;
        use crate::state::user::Order;

        #[test]
        fn bid_does_not_breach() {
            let _market = PerpMarket {
                margin_ratio_initial: (MARGIN_PRECISION / 10) as u32, // 10x
                ..PerpMarket::default()
            };

            let order = Order {
                price: 101 * PRICE_PRECISION_U64,
                ..Order::default()
            };

            let oracle_price = 100 * PRICE_PRECISION_I128;

            let slot = 0;
            let tick_size = 1;

            let margin_ratio_initial = MARGIN_PRECISION / 10;
            let margin_ratio_maintenance = MARGIN_PRECISION / 20;
            let result = order_breaches_oracle_price_limits(
                &order,
                oracle_price,
                slot,
                tick_size,
                margin_ratio_initial,
                margin_ratio_maintenance,
                None,
            )
            .unwrap();

            assert!(!result)
        }

        #[test]
        fn bid_does_not_breach_4_99_percent_move() {
            let _market = PerpMarket {
                margin_ratio_initial: (MARGIN_PRECISION / 10) as u32, // 10x
                ..PerpMarket::default()
            };

            let order = Order {
                price: 105 * PRICE_PRECISION_U64 - 1,
                ..Order::default()
            };

            let oracle_price = 100 * PRICE_PRECISION_I128;

            let slot = 0;
            let tick_size = 1;

            let margin_ratio_initial = MARGIN_PRECISION / 10;
            let margin_ratio_maintenance = MARGIN_PRECISION / 20;
            let result = order_breaches_oracle_price_limits(
                &order,
                oracle_price,
                slot,
                tick_size,
                margin_ratio_initial,
                margin_ratio_maintenance,
                None,
            )
            .unwrap();

            assert!(!result)
        }

        #[test]
        fn bid_breaches() {
            let _market = PerpMarket {
                margin_ratio_initial: (MARGIN_PRECISION / 10) as u32, // 10x
                margin_ratio_maintenance: (MARGIN_PRECISION / 20) as u32, // 20x
                ..PerpMarket::default()
            };

            let order = Order {
                direction: PositionDirection::Long,
                price: 105 * PRICE_PRECISION_U64,
                ..Order::default()
            };

            let oracle_price = 100 * PRICE_PRECISION_I128;

            let slot = 0;
            let tick_size = 1;

            let margin_ratio_initial = MARGIN_PRECISION / 10;
            let margin_ratio_maintenance = MARGIN_PRECISION / 20;
            let result = order_breaches_oracle_price_limits(
                &order,
                oracle_price,
                slot,
                tick_size,
                margin_ratio_initial,
                margin_ratio_maintenance,
                None,
            )
            .unwrap();

            assert!(result)
        }

        #[test]
        fn ask_does_not_breach() {
            let _market = PerpMarket {
                margin_ratio_initial: (MARGIN_PRECISION / 10) as u32, // 10x
                margin_ratio_maintenance: (MARGIN_PRECISION / 20) as u32, // 20x
                ..PerpMarket::default()
            };

            let order = Order {
                direction: PositionDirection::Short,
                price: 99 * PRICE_PRECISION_U64,
                ..Order::default()
            };

            let oracle_price = 100 * PRICE_PRECISION_I128;

            let slot = 0;
            let tick_size = 1;

            let margin_ratio_initial = MARGIN_PRECISION / 10;
            let margin_ratio_maintenance = MARGIN_PRECISION / 20;
            let result = order_breaches_oracle_price_limits(
                &order,
                oracle_price,
                slot,
                tick_size,
                margin_ratio_initial,
                margin_ratio_maintenance,
                None,
            )
            .unwrap();

            assert!(!result)
        }

        #[test]
        fn ask_does_not_breach_4_99_percent_move() {
            let _market = PerpMarket {
                margin_ratio_initial: (MARGIN_PRECISION / 10) as u32, // 10x
                margin_ratio_maintenance: (MARGIN_PRECISION / 20) as u32, // 20x
                ..PerpMarket::default()
            };

            let order = Order {
                direction: PositionDirection::Short,
                price: 95 * PRICE_PRECISION_U64 + 1,
                ..Order::default()
            };

            let oracle_price = 100 * PRICE_PRECISION_I128;

            let slot = 0;
            let tick_size = 1;

            let margin_ratio_initial = MARGIN_PRECISION / 10;
            let margin_ratio_maintenance = MARGIN_PRECISION / 20;
            let result = order_breaches_oracle_price_limits(
                &order,
                oracle_price,
                slot,
                tick_size,
                margin_ratio_initial,
                margin_ratio_maintenance,
                None,
            )
            .unwrap();

            assert!(!result)
        }

        #[test]
        fn ask_breaches() {
            let _market = PerpMarket {
                margin_ratio_initial: (MARGIN_PRECISION / 10) as u32, // 10x
                margin_ratio_maintenance: (MARGIN_PRECISION / 20) as u32, // 20x
                ..PerpMarket::default()
            };

            let order = Order {
                direction: PositionDirection::Short,
                price: 95 * PRICE_PRECISION_U64,
                ..Order::default()
            };

            let oracle_price = 100 * PRICE_PRECISION_I128;

            let slot = 0;
            let tick_size = 1;

            let margin_ratio_initial = MARGIN_PRECISION / 10;
            let margin_ratio_maintenance = MARGIN_PRECISION / 20;
            let result = order_breaches_oracle_price_limits(
                &order,
                oracle_price,
                slot,
                tick_size,
                margin_ratio_initial,
                margin_ratio_maintenance,
                None,
            )
            .unwrap();

            assert!(result)
        }
    }
}
