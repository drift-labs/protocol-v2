use std::cmp::min;
use std::ops::{Neg, Sub};

use solana_program::msg;

use crate::controller::position::PositionDelta;
use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::math::amm::calculate_amm_available_liquidity;
use crate::math::auction::is_auction_complete;
use crate::math::casting::Cast;
use crate::{
    math, BASE_PRECISION_I128, OPEN_ORDER_MARGIN_REQUIREMENT, PRICE_PRECISION_I128,
    QUOTE_PRECISION_I128, SPOT_WEIGHT_PRECISION, SPOT_WEIGHT_PRECISION_I128,
};

use crate::math::constants::MARGIN_PRECISION_U128;
use crate::math::margin::{
    calculate_margin_requirement_and_total_collateral_and_liability_info, MarginRequirementType,
};
use crate::math::position::calculate_entry_price;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::{get_strict_token_value, get_token_value};
use crate::math::spot_withdraw::calculate_availability_borrow_liquidity;
use crate::math_error;
use crate::print_error;
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::PerpMarket;
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::user::{
    MarketType, Order, OrderStatus, OrderTriggerCondition, PerpPosition, User,
};
use crate::validate;

#[cfg(test)]
mod tests;

pub fn calculate_base_asset_amount_for_amm_to_fulfill(
    order: &Order,
    market: &PerpMarket,
    valid_oracle_price: Option<i64>,
    slot: u64,
    override_limit_price: Option<u64>,
    existing_base_asset_amount: i64,
) -> DriftResult<(u64, Option<u64>)> {
    let limit_price = if let Some(override_limit_price) = override_limit_price {
        if let Some(limit_price) =
            order.get_limit_price(valid_oracle_price, None, slot, market.amm.order_tick_size)?
        {
            validate!(
                (limit_price >= override_limit_price && order.direction == PositionDirection::Long)
                    || (limit_price <= override_limit_price
                        && order.direction == PositionDirection::Short),
                ErrorCode::InvalidAmmLimitPriceOverride,
                "override_limit_price={} not better than order_limit_price={}",
                override_limit_price,
                limit_price
            )?;
        }

        Some(override_limit_price)
    } else {
        order.get_limit_price(valid_oracle_price, None, slot, market.amm.order_tick_size)?
    };

    if order.must_be_triggered() && !order.triggered() {
        return Ok((0, limit_price));
    }

    let base_asset_amount = calculate_base_asset_amount_to_fill_up_to_limit_price(
        order,
        market,
        limit_price,
        Some(existing_base_asset_amount),
    )?;
    let max_base_asset_amount = calculate_amm_available_liquidity(&market.amm, &order.direction)?;

    Ok((min(base_asset_amount, max_base_asset_amount), limit_price))
}

pub fn calculate_base_asset_amount_to_fill_up_to_limit_price(
    order: &Order,
    market: &PerpMarket,
    limit_price: Option<u64>,
    existing_base_asset_amount: Option<i64>,
) -> DriftResult<u64> {
    let base_asset_amount_unfilled =
        order.get_base_asset_amount_unfilled(existing_base_asset_amount)?;

    let (max_trade_base_asset_amount, max_trade_direction) = if let Some(limit_price) = limit_price
    {
        // buy to right below or sell up right above the limit price
        let adjusted_limit_price = match order.direction {
            PositionDirection::Long => limit_price.safe_sub(market.amm.order_tick_size)?,
            PositionDirection::Short => limit_price.safe_add(market.amm.order_tick_size)?,
        };

        math::amm_spread::calculate_base_asset_amount_to_trade_to_price(
            &market.amm,
            adjusted_limit_price,
            order.direction,
        )?
    } else {
        (base_asset_amount_unfilled, order.direction)
    };

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
) -> DriftResult<bool> {
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
    fill_price: u64,
    base_decimals: u32,
    position_direction: PositionDirection,
) -> DriftResult<u64> {
    let precision_decrease = 10_u128.pow(base_decimals);

    match position_direction {
        PositionDirection::Long => fill_price
            .cast::<u128>()?
            .safe_mul(base_asset_amount.cast()?)?
            .safe_div(precision_decrease)?
            .cast::<u64>(),
        PositionDirection::Short => fill_price
            .cast::<u128>()?
            .safe_mul(base_asset_amount.cast()?)?
            .safe_div_ceil(precision_decrease)?
            .cast::<u64>(),
    }
}

pub fn standardize_base_asset_amount_with_remainder_i128(
    base_asset_amount: i128,
    step_size: u128,
) -> DriftResult<(i128, i128)> {
    let remainder = base_asset_amount
        .unsigned_abs()
        .checked_rem_euclid(step_size)
        .ok_or_else(math_error!())?
        .cast::<i128>()?
        .safe_mul(base_asset_amount.signum())?;

    let standardized_base_asset_amount = base_asset_amount.safe_sub(remainder)?;

    Ok((standardized_base_asset_amount, remainder))
}

pub fn standardize_base_asset_amount(base_asset_amount: u64, step_size: u64) -> DriftResult<u64> {
    let remainder = base_asset_amount
        .checked_rem_euclid(step_size)
        .ok_or_else(math_error!())?;

    base_asset_amount.safe_sub(remainder)
}

pub fn standardize_base_asset_amount_ceil(
    base_asset_amount: u64,
    step_size: u64,
) -> DriftResult<u64> {
    let remainder = base_asset_amount
        .checked_rem_euclid(step_size)
        .ok_or_else(math_error!())?;

    if remainder == 0 {
        Ok(base_asset_amount)
    } else {
        base_asset_amount.safe_add(step_size)?.safe_sub(remainder)
    }
}

pub fn is_multiple_of_step_size(base_asset_amount: u64, step_size: u64) -> DriftResult<bool> {
    let remainder = base_asset_amount
        .checked_rem_euclid(step_size)
        .ok_or_else(math_error!())?;

    Ok(remainder == 0)
}

pub fn standardize_price(
    price: u64,
    tick_size: u64,
    direction: PositionDirection,
) -> DriftResult<u64> {
    if price == 0 {
        return Ok(0);
    }

    let remainder = price
        .checked_rem_euclid(tick_size)
        .ok_or_else(math_error!())?;

    if remainder == 0 {
        return Ok(price);
    }

    match direction {
        PositionDirection::Long => price.safe_sub(remainder),
        PositionDirection::Short => price.safe_add(tick_size)?.safe_sub(remainder),
    }
}

pub fn standardize_price_i64(
    price: i64,
    tick_size: i64,
    direction: PositionDirection,
) -> DriftResult<i64> {
    if price == 0 {
        return Ok(0);
    }

    let remainder = price
        .checked_rem_euclid(tick_size)
        .ok_or_else(math_error!())?;

    if remainder == 0 {
        return Ok(price);
    }

    match direction {
        PositionDirection::Long => price.safe_sub(remainder),
        PositionDirection::Short => price.safe_add(tick_size)?.safe_sub(remainder),
    }
}

#[cfg(test)]
mod test2 {
    use crate::controller::position::PositionDirection;
    use crate::math::orders::standardize_price_i64;

    #[test]
    fn test() {
        let price = -1001_i64;

        let result = standardize_price_i64(price, 100, PositionDirection::Long).unwrap();

        println!("result {}", result);
    }
}

pub fn get_position_delta_for_fill(
    base_asset_amount: u64,
    quote_asset_amount: u64,
    direction: PositionDirection,
) -> DriftResult<PositionDelta> {
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

pub fn should_cancel_market_order_after_fill(
    user: &User,
    user_order_index: usize,
    slot: u64,
) -> DriftResult<bool> {
    let order = &user.orders[user_order_index];
    if !order.is_market_order() || order.status != OrderStatus::Open {
        return Ok(false);
    }

    Ok(order.has_limit_price(slot)?
        && is_auction_complete(order.slot, order.auction_duration, slot)?)
}

pub fn should_expire_order(user: &User, user_order_index: usize, now: i64) -> DriftResult<bool> {
    let order = &user.orders[user_order_index];
    if order.status != OrderStatus::Open || order.max_ts == 0 || order.must_be_triggered() {
        return Ok(false);
    }

    Ok(now > order.max_ts)
}

pub fn should_cancel_reduce_only_order(
    order: &Order,
    existing_base_asset_amount: i64,
) -> DriftResult<bool> {
    let should_cancel = order.status == OrderStatus::Open
        && order.reduce_only
        && order.get_base_asset_amount_unfilled(Some(existing_base_asset_amount))? == 0;

    Ok(should_cancel)
}

pub fn order_breaches_oracle_price_bands(
    order: &Order,
    oracle_price: i64,
    slot: u64,
    tick_size: u64,
    margin_ratio_initial: u32,
    margin_ratio_maintenance: u32,
) -> DriftResult<bool> {
    let order_limit_price =
        order.force_get_limit_price(Some(oracle_price), None, slot, tick_size)?;
    limit_price_breaches_oracle_price_bands(
        order_limit_price,
        order.direction,
        oracle_price,
        margin_ratio_initial,
        margin_ratio_maintenance,
    )
}

pub fn limit_price_breaches_oracle_price_bands(
    order_limit_price: u64,
    order_direction: PositionDirection,
    oracle_price: i64,
    margin_ratio_initial: u32,
    margin_ratio_maintenance: u32,
) -> DriftResult<bool> {
    let oracle_price = oracle_price.unsigned_abs();

    let max_percent_diff = margin_ratio_initial.safe_sub(margin_ratio_maintenance)?;

    match order_direction {
        PositionDirection::Long => {
            if order_limit_price <= oracle_price {
                return Ok(false);
            }

            let percent_diff = order_limit_price
                .safe_sub(oracle_price)?
                .cast::<u128>()?
                .safe_mul(MARGIN_PRECISION_U128)?
                .safe_div(oracle_price.cast()?)?;

            if percent_diff >= max_percent_diff.cast()? {
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
                .safe_sub(order_limit_price)?
                .cast::<u128>()?
                .safe_mul(MARGIN_PRECISION_U128)?
                .safe_div(oracle_price.cast()?)?;

            if percent_diff >= max_percent_diff.cast()? {
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

pub fn order_satisfies_trigger_condition(order: &Order, oracle_price: u64) -> DriftResult<bool> {
    match order.trigger_condition {
        OrderTriggerCondition::Above => Ok(oracle_price > order.trigger_price),
        OrderTriggerCondition::Below => Ok(oracle_price < order.trigger_price),
        _ => Err(print_error!(ErrorCode::InvalidTriggerOrderCondition)()),
    }
}

pub fn is_spot_order_risk_decreasing(
    order: &Order,
    balance_type: &SpotBalanceType,
    token_amount: u128,
) -> DriftResult<bool> {
    let risk_decreasing = match (balance_type, order.direction) {
        (SpotBalanceType::Deposit, PositionDirection::Short) => {
            (order.base_asset_amount as u128) < token_amount.safe_mul(2)?
        }
        (SpotBalanceType::Borrow, PositionDirection::Long) => {
            (order.base_asset_amount as u128) < token_amount.safe_mul(2)?
        }
        (_, _) => false,
    };

    Ok(risk_decreasing)
}

pub fn is_spot_order_risk_increasing(
    order: &Order,
    balance_type: &SpotBalanceType,
    token_amount: u128,
) -> DriftResult<bool> {
    is_spot_order_risk_decreasing(order, balance_type, token_amount)
        .map(|risk_decreasing| !risk_decreasing)
}

pub fn is_order_risk_decreasing(
    order_direction: &PositionDirection,
    order_base_asset_amount: u64,
    position_base_asset_amount: i64,
) -> DriftResult<bool> {
    Ok(match order_direction {
        // User is short and order is long
        PositionDirection::Long if position_base_asset_amount < 0 => {
            order_base_asset_amount < position_base_asset_amount.unsigned_abs().safe_mul(2)?
        }
        // User is long and order is short
        PositionDirection::Short if position_base_asset_amount > 0 => {
            order_base_asset_amount < position_base_asset_amount.unsigned_abs().safe_mul(2)?
        }
        _ => false,
    })
}

pub fn is_order_risk_increasing(
    order_direction: &PositionDirection,
    order_base_asset_amount: u64,
    position_base_asset_amount: i64,
) -> DriftResult<bool> {
    is_order_risk_decreasing(
        order_direction,
        order_base_asset_amount,
        position_base_asset_amount,
    )
    .map(|risk_decreasing| !risk_decreasing)
}

pub fn is_order_position_reducing(
    order_direction: &PositionDirection,
    order_base_asset_amount: u64,
    position_base_asset_amount: i64,
) -> DriftResult<bool> {
    Ok(match order_direction {
        // User is short and order is long
        PositionDirection::Long if position_base_asset_amount < 0 => {
            order_base_asset_amount <= position_base_asset_amount.unsigned_abs()
        }
        // User is long and order is short
        PositionDirection::Short if position_base_asset_amount > 0 => {
            order_base_asset_amount <= position_base_asset_amount.unsigned_abs()
        }
        _ => false,
    })
}

pub fn validate_fill_price(
    quote_asset_amount: u64,
    base_asset_amount: u64,
    base_precision: u64,
    order_direction: PositionDirection,
    order_limit_price: u64,
    is_taker: bool,
) -> DriftResult {
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
        .safe_mul(base_precision as u128)?
        .safe_div(base_asset_amount.cast()?)?
        .cast::<u64>()?;

    if order_direction == PositionDirection::Long && fill_price > order_limit_price {
        msg!(
            "long order fill price ({} = {}/{} * 1000) > limit price ({}) is_taker={}",
            fill_price,
            quote_asset_amount,
            base_asset_amount,
            order_limit_price,
            is_taker
        );
        return Err(ErrorCode::InvalidOrderFillPrice);
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
        return Err(ErrorCode::InvalidOrderFillPrice);
    }

    Ok(())
}

pub fn get_fallback_price(
    direction: &PositionDirection,
    bid_price: u64,
    ask_price: u64,
    amm_available_liquidity: u64,
    oracle_price: i64,
) -> DriftResult<u64> {
    let oracle_price = oracle_price.unsigned_abs();
    match direction {
        PositionDirection::Long if amm_available_liquidity > 0 => {
            ask_price.safe_add(ask_price / 200)
        }
        PositionDirection::Long => oracle_price.safe_add(oracle_price / 20),
        PositionDirection::Short if amm_available_liquidity > 0 => {
            bid_price.safe_sub(bid_price / 200)
        }
        PositionDirection::Short => oracle_price.safe_sub(oracle_price / 20),
    }
}

pub fn get_max_fill_amounts(
    user: &User,
    user_order_index: usize,
    base_market: &SpotMarket,
    quote_market: &SpotMarket,
) -> DriftResult<(Option<u64>, Option<u64>)> {
    let direction: PositionDirection = user.orders[user_order_index].direction;
    match direction {
        PositionDirection::Long => {
            let max_quote = get_max_fill_amounts_for_market(user, quote_market)?.cast::<u64>()?;
            Ok((None, Some(max_quote)))
        }
        PositionDirection::Short => {
            let max_base = standardize_base_asset_amount(
                get_max_fill_amounts_for_market(user, base_market)?.cast::<u64>()?,
                base_market.order_step_size,
            )?;
            Ok((Some(max_base), None))
        }
    }
}

fn get_max_fill_amounts_for_market(user: &User, market: &SpotMarket) -> DriftResult<u128> {
    let position_index = user.get_spot_position_index(market.market_index)?;
    let token_amount = user.spot_positions[position_index].get_signed_token_amount(market)?;
    get_max_withdraw_for_market_with_token_amount(token_amount, market)
}

#[inline(always)]
pub fn get_max_withdraw_for_market_with_token_amount(
    token_amount: i128,
    market: &SpotMarket,
) -> DriftResult<u128> {
    let available_borrow_liquidity = calculate_availability_borrow_liquidity(market)?;
    token_amount
        .max(0)
        .unsigned_abs()
        .safe_add(available_borrow_liquidity)
}

pub fn find_fallback_maker_order(
    user: &User,
    direction: &PositionDirection,
    market_type: &MarketType,
    market_index: u16,
    valid_oracle_price: Option<i64>,
    slot: u64,
    tick_size: u64,
) -> DriftResult<Option<usize>> {
    let mut best_limit_price = match direction {
        PositionDirection::Long => 0,
        PositionDirection::Short => u64::MAX,
    };
    let mut fallback_maker_order_index = None;

    for (order_index, order) in user.orders.iter().enumerate() {
        if order.status != OrderStatus::Open {
            continue;
        }

        // if order direction is not same or market type is not same or market index is the same, skip
        if order.direction != *direction
            || order.market_type != *market_type
            || order.market_index != market_index
        {
            continue;
        }

        // if order is not limit order or must be triggered and not triggered, skip
        if !order.is_limit_order() || (order.must_be_triggered() && !order.triggered()) {
            continue;
        }

        let limit_price = order.force_get_limit_price(valid_oracle_price, None, slot, tick_size)?;

        // if fallback maker order is not set, set it else check if this order is better
        if fallback_maker_order_index.is_none()
            || *direction == PositionDirection::Long && limit_price > best_limit_price
            || *direction == PositionDirection::Short && limit_price < best_limit_price
        {
            best_limit_price = limit_price;
            fallback_maker_order_index = Some(order_index);
        }
    }

    Ok(fallback_maker_order_index)
}

pub fn find_maker_orders(
    user: &User,
    direction: &PositionDirection,
    market_type: &MarketType,
    market_index: u16,
    valid_oracle_price: Option<i64>,
    slot: u64,
    tick_size: u64,
) -> DriftResult<Vec<(usize, u64)>> {
    let mut orders: Vec<(usize, u64)> = Vec::with_capacity(32);

    for (order_index, order) in user.orders.iter().enumerate() {
        if order.status != OrderStatus::Open {
            continue;
        }

        // if order direction is not same or market type is not same or market index is the same, skip
        if order.direction != *direction
            || order.market_type != *market_type
            || order.market_index != market_index
        {
            continue;
        }

        // if order is not limit order or must be triggered and not triggered, skip
        if !order.is_limit_order() || (order.must_be_triggered() && !order.triggered()) {
            continue;
        }

        let limit_price = order.force_get_limit_price(valid_oracle_price, None, slot, tick_size)?;

        orders.push((order_index, limit_price));
    }

    Ok(orders)
}

pub fn calculate_max_perp_order_size(
    user: &User,
    position_index: usize,
    market_index: u16,
    direction: PositionDirection,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> DriftResult<u64> {
    // calculate initial margin requirement
    let (margin_requirement, total_collateral, _, _, _, _) =
        calculate_margin_requirement_and_total_collateral_and_liability_info(
            user,
            perp_market_map,
            MarginRequirementType::Initial,
            spot_market_map,
            oracle_map,
            None,
            true,
        )?;

    let free_collateral = total_collateral.safe_sub(margin_requirement.cast()?)?;

    let perp_market = perp_market_map.get_ref(&market_index)?;

    let oracle_price_data = oracle_map.get_price_data(&perp_market.amm.oracle)?;

    let perp_position: &PerpPosition = &user.perp_positions[position_index];
    let base_asset_amount = perp_position.base_asset_amount;
    let worst_case_base_asset_amount = perp_position.worst_case_base_asset_amount()?;

    let margin_ratio = perp_market.get_margin_ratio(
        worst_case_base_asset_amount.unsigned_abs(),
        MarginRequirementType::Initial,
    )?;

    let mut order_size_to_flip = 0_u64;
    // account for order flipping worst case base asset amount
    if worst_case_base_asset_amount < 0 && direction == PositionDirection::Long {
        order_size_to_flip = worst_case_base_asset_amount
            .abs()
            .cast::<i64>()?
            .safe_sub(base_asset_amount.safe_add(perp_position.open_bids)?)?
            .unsigned_abs();
    } else if worst_case_base_asset_amount > 0 && direction == PositionDirection::Short {
        order_size_to_flip = worst_case_base_asset_amount
            .neg()
            .cast::<i64>()?
            .safe_sub(base_asset_amount.safe_add(perp_position.open_asks)?)?
            .unsigned_abs();
    }

    if free_collateral <= 0 {
        let max_risk_reducing_order_size = base_asset_amount
            .safe_mul(2)?
            .unsigned_abs()
            .saturating_sub(1);
        return standardize_base_asset_amount(
            order_size_to_flip.min(max_risk_reducing_order_size),
            perp_market.amm.order_step_size,
        );
    }

    let mut order_size = free_collateral
        .safe_sub(OPEN_ORDER_MARGIN_REQUIREMENT.cast()?)?
        .safe_mul(BASE_PRECISION_I128 / QUOTE_PRECISION_I128)?
        .safe_mul(MARGIN_PRECISION_U128.cast()?)?
        .safe_div(margin_ratio.cast()?)?
        .safe_mul(PRICE_PRECISION_I128)?
        .safe_div(oracle_price_data.price.cast()?)?
        .cast::<u64>()?;

    let updated_margin_ratio = perp_market.get_margin_ratio(
        worst_case_base_asset_amount
            .unsigned_abs()
            .safe_add(order_size.cast()?)?,
        MarginRequirementType::Initial,
    )?;

    if updated_margin_ratio != margin_ratio {
        order_size = free_collateral
            .safe_sub(OPEN_ORDER_MARGIN_REQUIREMENT.cast()?)?
            .safe_mul(BASE_PRECISION_I128 / QUOTE_PRECISION_I128)?
            .safe_mul(MARGIN_PRECISION_U128.cast()?)?
            .safe_div(updated_margin_ratio.cast()?)?
            .safe_mul(PRICE_PRECISION_I128)?
            .safe_div(oracle_price_data.price.cast()?)?
            .cast::<u64>()?;
    }

    standardize_base_asset_amount(
        order_size.safe_add(order_size_to_flip)?,
        perp_market.amm.order_step_size,
    )
}

pub fn calculate_max_spot_order_size(
    user: &User,
    market_index: u16,
    direction: PositionDirection,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> DriftResult<u64> {
    // calculate initial margin requirement
    let (margin_requirement, total_collateral, _, _, _, _) =
        calculate_margin_requirement_and_total_collateral_and_liability_info(
            user,
            perp_market_map,
            MarginRequirementType::Initial,
            spot_market_map,
            oracle_map,
            None,
            true,
        )?;

    let mut order_size_to_flip = 0_u64;
    let mut free_collateral = total_collateral.safe_sub(margin_requirement.cast()?)?;

    let spot_market = spot_market_map.get_ref(&market_index)?;

    let quote_initial_asset_weight = spot_market_map
        .get_quote_spot_market()?
        .initial_asset_weight
        .cast::<i128>()?;

    let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle)?;
    let twap = spot_market
        .historical_oracle_data
        .last_oracle_price_twap_5min;
    let max_oracle_price = oracle_price_data.price.max(twap);

    let spot_position = user.get_spot_position(market_index)?;
    let signed_token_amount = spot_position.get_signed_token_amount(&spot_market)?;
    let (worst_case_token_amount, worst_case_quote_amount) = spot_position
        .get_worst_case_token_amounts(
            &spot_market,
            oracle_price_data,
            Some(twap),
            Some(signed_token_amount),
        )?;

    let token_value_before = get_strict_token_value(
        signed_token_amount,
        spot_market.decimals,
        oracle_price_data,
        twap,
    )?;

    let worst_case_token_value_before =
        token_value_before.safe_add(worst_case_quote_amount.neg())?;

    // account for order flipping worst case base asset amount
    if worst_case_token_amount < 0 && direction == PositionDirection::Long {
        // first figure out how much free collateral existing positions/orders consumed
        let liability_weight = spot_market.get_liability_weight(
            worst_case_token_amount.unsigned_abs(),
            &MarginRequirementType::Initial,
        )?;

        let free_collateral_consumption_before = worst_case_quote_amount
            .safe_mul(quote_initial_asset_weight)?
            .safe_div(SPOT_WEIGHT_PRECISION_I128)?
            .safe_add(
                worst_case_token_value_before
                    .safe_mul(liability_weight.cast()?)?
                    .safe_div(SPOT_WEIGHT_PRECISION.cast()?)?,
            )?;

        // then calculate the free collateral consumed by placing order to flip worst case token amount

        // e.g. worst case: -15, signed token amount: 2, open bids: 5
        // then bids_to_flip = 15 - (2 + 5) = 8
        let bids_to_flip = worst_case_token_amount
            .abs()
            .safe_sub(signed_token_amount.safe_add(spot_position.open_bids.cast()?)?)?;

        let worst_case_quote_amount_after = -get_token_value(
            spot_position
                .open_bids
                .cast::<i128>()?
                .safe_add(bids_to_flip)?,
            spot_market.decimals,
            max_oracle_price,
        )?;

        let worst_case_token_value_after =
            token_value_before.safe_add(worst_case_quote_amount_after.neg())?;

        let asset_weight = spot_market.get_asset_weight(
            worst_case_token_amount.unsigned_abs(),
            &MarginRequirementType::Initial,
        )?;

        let free_collateral_consumption_after = worst_case_token_value_after
            .safe_mul(asset_weight.cast()?)?
            .safe_div(SPOT_WEIGHT_PRECISION.cast()?)?
            .safe_add(worst_case_quote_amount_after)?;

        free_collateral = free_collateral.safe_add(
            free_collateral_consumption_after.safe_sub(free_collateral_consumption_before)?,
        )?;

        order_size_to_flip = bids_to_flip.cast()?;
    } else if worst_case_token_amount > 0 && direction == PositionDirection::Short {
        let asset_weight = spot_market.get_asset_weight(
            worst_case_token_amount.unsigned_abs(),
            &MarginRequirementType::Initial,
        )?;

        let free_collateral_contribution_before = worst_case_token_value_before
            .safe_mul(asset_weight.cast()?)?
            .safe_div(SPOT_WEIGHT_PRECISION.cast()?)?
            .safe_add(worst_case_quote_amount)?;

        let asks_to_flip = worst_case_token_amount
            .neg()
            .safe_sub(signed_token_amount.safe_add(spot_position.open_asks.cast()?)?)?;

        let worst_case_quote_amount_after = -get_token_value(
            spot_position
                .open_asks
                .cast::<i128>()?
                .safe_add(asks_to_flip)?,
            spot_market.decimals,
            max_oracle_price,
        )?;

        let worst_case_token_value_after =
            token_value_before.safe_add(worst_case_quote_amount_after.neg())?;

        let liability_weight = spot_market.get_liability_weight(
            worst_case_token_amount.unsigned_abs(),
            &MarginRequirementType::Initial,
        )?;

        let free_collateral_contribution_after = worst_case_quote_amount_after.safe_add(
            worst_case_token_value_after
                .safe_mul(liability_weight.cast()?)?
                .safe_div(SPOT_WEIGHT_PRECISION.cast()?)?,
        )?;

        free_collateral = free_collateral.safe_add(
            free_collateral_contribution_after.safe_sub(free_collateral_contribution_before)?,
        )?;

        order_size_to_flip = asks_to_flip.abs().cast()?;
    }

    if free_collateral <= 0 {
        let max_risk_reducing_order_size = signed_token_amount
            .safe_mul(2)?
            .abs()
            .cast::<u64>()?
            .saturating_sub(1);
        return standardize_base_asset_amount(
            order_size_to_flip.min(max_risk_reducing_order_size),
            spot_market.order_step_size,
        );
    }

    let free_collateral_delta = calculate_free_collateral_delta_for_spot(
        &spot_market,
        worst_case_token_amount.unsigned_abs(),
        direction,
        quote_initial_asset_weight.cast()?,
    )?;

    let precision_increase = 10i128.pow(spot_market.decimals - 6);

    let mut order_size = free_collateral
        .safe_sub(OPEN_ORDER_MARGIN_REQUIREMENT.cast()?)?
        .safe_mul(precision_increase)?
        .safe_mul(SPOT_WEIGHT_PRECISION.cast()?)?
        .safe_div(free_collateral_delta.cast()?)?
        .safe_mul(PRICE_PRECISION_I128)?
        .safe_div(max_oracle_price.cast()?)?
        .cast::<u64>()?;

    // increasing the worst case token amount with new order size may increase margin ration,
    // so need to recalculate free collateral delta with updated margin ratio
    let updated_free_collateral_delta = calculate_free_collateral_delta_for_spot(
        &spot_market,
        worst_case_token_amount
            .unsigned_abs()
            .safe_add(order_size.cast()?)?,
        direction,
        quote_initial_asset_weight.cast()?,
    )?;

    if updated_free_collateral_delta != free_collateral_delta {
        order_size = free_collateral
            .safe_sub(OPEN_ORDER_MARGIN_REQUIREMENT.cast()?)?
            .safe_mul(precision_increase)?
            .safe_mul(SPOT_WEIGHT_PRECISION.cast()?)?
            .safe_div(updated_free_collateral_delta.cast()?)?
            .safe_mul(PRICE_PRECISION_I128)?
            .safe_div(max_oracle_price.cast()?)?
            .cast::<u64>()?;
    }

    standardize_base_asset_amount(
        order_size.safe_add(order_size_to_flip)?,
        spot_market.order_step_size,
    )
}

fn calculate_free_collateral_delta_for_spot(
    spot_market: &SpotMarket,
    worst_case_token_amount: u128,
    order_direction: PositionDirection,
    quote_asset_weight: u32,
) -> DriftResult<u32> {
    Ok(if order_direction == PositionDirection::Long {
        SPOT_WEIGHT_PRECISION.sub(
            spot_market
                .get_asset_weight(worst_case_token_amount, &MarginRequirementType::Initial)?,
        )
    } else {
        spot_market
            .get_liability_weight(worst_case_token_amount, &MarginRequirementType::Initial)?
            .sub(quote_asset_weight)
    })
}
