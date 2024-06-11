use std::cmp::min;
use std::ops::{Neg, Sub};

use solana_program::msg;

use crate::controller::position::PositionDelta;
use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::math::amm::calculate_amm_available_liquidity;
use crate::math::auction::is_amm_available_liquidity_source;
use crate::math::casting::Cast;
use crate::{
    load, math, FeeTier, State, BASE_PRECISION_I128, FEE_ADJUSTMENT_MAX,
    OPEN_ORDER_MARGIN_REQUIREMENT, PERCENTAGE_PRECISION, PERCENTAGE_PRECISION_U64,
    PRICE_PRECISION_I128, QUOTE_PRECISION_I128, SPOT_WEIGHT_PRECISION, SPOT_WEIGHT_PRECISION_I128,
};

use crate::math::constants::MARGIN_PRECISION_U128;
use crate::math::margin::{
    calculate_margin_requirement_and_total_collateral_and_liability_info, MarginRequirementType,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_strict_token_value;
use crate::math::spot_withdraw::get_max_withdraw_for_market_with_token_amount;
use crate::math_error;
use crate::print_error;
use crate::state::margin_calculation::{MarginCalculation, MarginContext};
use crate::state::oracle::{OraclePriceData, StrictOraclePrice};
use crate::state::oracle_map::OracleMap;
use crate::state::order_params::PostOnlyParam;
use crate::state::perp_market::{PerpMarket, AMM};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::SpotMarket;
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::user::{
    MarketType, Order, OrderFillSimulation, OrderStatus, OrderTriggerCondition, PerpPosition, User,
};
use crate::state::user_map::UserMap;
use crate::validate;

#[cfg(test)]
mod tests;

pub fn calculate_base_asset_amount_for_amm_to_fulfill(
    order: &Order,
    market: &PerpMarket,
    limit_price: Option<u64>,
    override_fill_price: Option<u64>,
    existing_base_asset_amount: i64,
    fee_tier: &FeeTier,
) -> DriftResult<(u64, Option<u64>)> {
    let limit_price = if let Some(override_fill_price) = override_fill_price {
        if let Some(limit_price) = limit_price {
            validate!(
                (limit_price >= override_fill_price && order.direction == PositionDirection::Long)
                    || (limit_price <= override_fill_price
                        && order.direction == PositionDirection::Short),
                ErrorCode::InvalidAmmLimitPriceOverride,
                "override_limit_price={} not better than order_limit_price={}",
                override_fill_price,
                limit_price
            )?;
        }

        Some(override_fill_price)
    } else {
        limit_price
    };

    if order.must_be_triggered() && !order.triggered() {
        return Ok((0, limit_price));
    }

    let limit_price_with_buffer =
        calculate_limit_price_with_buffer(order, limit_price, fee_tier, market.fee_adjustment)?;

    let base_asset_amount = calculate_base_asset_amount_to_fill_up_to_limit_price(
        order,
        market,
        limit_price_with_buffer,
        Some(existing_base_asset_amount),
    )?;
    let max_base_asset_amount = calculate_amm_available_liquidity(&market.amm, &order.direction)?;

    Ok((min(base_asset_amount, max_base_asset_amount), limit_price))
}

fn calculate_limit_price_with_buffer(
    order: &Order,
    limit_price: Option<u64>,
    fee_tier: &FeeTier,
    fee_adjustment: i16,
) -> DriftResult<Option<u64>> {
    if !order.post_only {
        Ok(limit_price)
    } else if let Some(limit_price) = limit_price {
        let mut buffer = limit_price
            .safe_mul(fee_tier.maker_rebate_numerator.cast()?)?
            .safe_div(fee_tier.maker_rebate_denominator.cast()?)?;

        if fee_adjustment < 0 {
            let buffer_adjustment = buffer
                .safe_mul(fee_adjustment.abs().cast()?)?
                .safe_div(FEE_ADJUSTMENT_MAX)?;
            buffer = buffer.saturating_sub(buffer_adjustment);
        } else if fee_adjustment > 0 {
            let buffer_adjustment = buffer
                .safe_mul(fee_adjustment.cast()?)?
                .safe_div(FEE_ADJUSTMENT_MAX)?;
            buffer = buffer.saturating_add(buffer_adjustment);
        }

        match order.direction {
            PositionDirection::Long => limit_price.safe_sub(buffer).map(Some),
            PositionDirection::Short => limit_price.safe_add(buffer).map(Some),
        }
    } else {
        Ok(None)
    }
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

pub fn get_price_for_perp_order(
    price: u64,
    direction: PositionDirection,
    post_only: PostOnlyParam,
    amm: &AMM,
) -> DriftResult<u64> {
    let mut limit_price = standardize_price(price, amm.order_tick_size, direction)?;

    if post_only == PostOnlyParam::Slide {
        let reserve_price = amm.reserve_price()?;
        match direction {
            PositionDirection::Long => {
                let amm_ask = amm.ask_price(reserve_price)?;
                if limit_price >= amm_ask {
                    limit_price = amm_ask.safe_sub(amm.order_tick_size)?;
                }
            }
            PositionDirection::Short => {
                let amm_bid = amm.bid_price(reserve_price)?;
                if limit_price <= amm_bid {
                    limit_price = amm_bid.safe_add(amm.order_tick_size)?;
                }
            }
        }
    }

    Ok(limit_price)
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
        remainder_base_asset_amount: None,
    })
}

#[inline(always)]
pub fn validate_perp_fill_possible(
    state: &State,
    user: &User,
    order_index: usize,
    slot: u64,
    num_makers: usize,
) -> DriftResult {
    let amm_available = is_amm_available_liquidity_source(
        &user.orders[order_index],
        state.min_perp_auction_duration,
        slot,
    )?;

    if !amm_available && num_makers == 0 && user.orders[order_index].is_limit_order() {
        msg!("invalid fill. order is limit order, amm is not available and no makers present");
        return Err(ErrorCode::ImpossibleFill);
    }

    Ok(())
}

#[inline(always)]
pub fn should_expire_order_before_fill(
    user: &User,
    order_index: usize,
    now: i64,
) -> DriftResult<bool> {
    let should_order_be_expired = should_expire_order(user, order_index, now)?;
    if should_order_be_expired && user.orders[order_index].is_limit_order() {
        let now_sub_buffer = now.safe_sub(15)?;
        if !should_expire_order(user, order_index, now_sub_buffer)? {
            msg!("invalid fill. cant force expire limit order until 15s after max_ts. max ts {}, now {}, now plus buffer {}", user.orders[order_index].max_ts, now, now_sub_buffer);
            return Err(ErrorCode::ImpossibleFill);
        }
    }

    Ok(should_order_be_expired)
}

#[inline(always)]
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
    step_size: u64,
) -> DriftResult<bool> {
    let should_cancel = order.status == OrderStatus::Open
        && order.reduce_only
        && order.get_base_asset_amount_unfilled(Some(existing_base_asset_amount))? < step_size;

    Ok(should_cancel)
}

pub fn order_breaches_maker_oracle_price_bands(
    order: &Order,
    oracle_price: i64,
    slot: u64,
    tick_size: u64,
    margin_ratio_initial: u32,
) -> DriftResult<bool> {
    let order_limit_price =
        order.force_get_limit_price(Some(oracle_price), None, slot, tick_size)?;
    limit_price_breaches_maker_oracle_price_bands(
        order_limit_price,
        order.direction,
        oracle_price,
        margin_ratio_initial,
    )
}

/// Cancel maker order if there limit price cross the oracle price sufficiently
/// E.g. if initial margin ratio is .05 and oracle price is 100, then maker limit price must be
/// less than 105 to be valid
pub fn limit_price_breaches_maker_oracle_price_bands(
    order_limit_price: u64,
    order_direction: PositionDirection,
    oracle_price: i64,
    margin_ratio_initial: u32,
) -> DriftResult<bool> {
    let oracle_price = oracle_price.unsigned_abs();

    let max_percent_diff = margin_ratio_initial;

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

pub fn validate_fill_price_within_price_bands(
    fill_price: u64,
    direction: PositionDirection,
    oracle_price: i64,
    oracle_twap_5min: i64,
    margin_ratio_initial: u32,
    oracle_twap_5min_percent_divergence: u64,
) -> DriftResult {
    let oracle_price = oracle_price.unsigned_abs();
    let oracle_twap_5min = oracle_twap_5min.unsigned_abs();

    let max_oracle_diff = margin_ratio_initial.cast::<u128>()?;
    let max_oracle_twap_diff = oracle_twap_5min_percent_divergence.cast::<u128>()?; // 50%

    if direction == PositionDirection::Long {
        if fill_price < oracle_price && fill_price < oracle_twap_5min {
            return Ok(());
        }

        let percent_diff: u128 = fill_price
            .saturating_sub(oracle_price)
            .cast::<u128>()?
            .safe_mul(MARGIN_PRECISION_U128)?
            .safe_div(oracle_price.cast()?)?;

        validate!(
            percent_diff < max_oracle_diff,
            ErrorCode::PriceBandsBreached,
            "Fill Price Breaches Oracle Price Bands: {} % <= {} % (fill: {} >= oracle: {})",
            max_oracle_diff,
            percent_diff,
            fill_price,
            oracle_price
        )?;

        let percent_diff = fill_price
            .saturating_sub(oracle_twap_5min)
            .cast::<u128>()?
            .safe_mul(PERCENTAGE_PRECISION)?
            .safe_div(oracle_twap_5min.cast()?)?;

        validate!(
            percent_diff < max_oracle_twap_diff,
            ErrorCode::PriceBandsBreached,
            "Fill Price Breaches Oracle TWAP Price Bands:  {} % <= {} % (fill: {} >= twap: {})",
            max_oracle_twap_diff,
            percent_diff,
            fill_price,
            oracle_twap_5min
        )?;
    } else {
        if fill_price > oracle_price && fill_price > oracle_twap_5min {
            return Ok(());
        }

        let percent_diff: u128 = oracle_price
            .saturating_sub(fill_price)
            .cast::<u128>()?
            .safe_mul(MARGIN_PRECISION_U128)?
            .safe_div(oracle_price.cast()?)?;

        validate!(
            percent_diff < max_oracle_diff,
            ErrorCode::PriceBandsBreached,
            "Fill Price Breaches Oracle Price Bands: {} % <= {} % (fill: {} <= oracle: {})",
            max_oracle_diff,
            percent_diff,
            fill_price,
            oracle_price
        )?;

        let percent_diff = oracle_twap_5min
            .saturating_sub(fill_price)
            .cast::<u128>()?
            .safe_mul(PERCENTAGE_PRECISION)?
            .safe_div(oracle_twap_5min.cast()?)?;

        validate!(
            percent_diff < max_oracle_twap_diff,
            ErrorCode::PriceBandsBreached,
            "Fill Price Breaches Oracle TWAP Price Bands:  {} % <= {} % (fill: {} <= twap: {})",
            max_oracle_twap_diff,
            percent_diff,
            fill_price,
            oracle_twap_5min
        )?;
    }

    Ok(())
}

pub fn is_oracle_too_divergent_with_twap_5min(
    oracle_price: i64,
    oracle_twap_5min: i64,
    max_divergence: i64,
) -> DriftResult<bool> {
    let percent_diff = oracle_price
        .safe_sub(oracle_twap_5min)?
        .abs()
        .safe_mul(PERCENTAGE_PRECISION_U64.cast::<i64>()?)?
        .safe_div(oracle_twap_5min.abs())?;

    let too_divergent = percent_diff >= max_divergence;
    if too_divergent {
        msg!("max divergence {}", max_divergence);
        msg!(
            "Oracle Price Too Divergent from TWAP 5min. oracle: {} twap: {}",
            oracle_price,
            oracle_twap_5min
        );
    }

    Ok(too_divergent)
}

pub fn order_satisfies_trigger_condition(order: &Order, oracle_price: u64) -> DriftResult<bool> {
    match order.trigger_condition {
        OrderTriggerCondition::Above => Ok(oracle_price > order.trigger_price),
        OrderTriggerCondition::Below => Ok(oracle_price < order.trigger_price),
        _ => Err(print_error!(ErrorCode::InvalidTriggerOrderCondition)()),
    }
}

pub fn is_new_order_risk_increasing(
    order: &Order,
    position_base_asset_amount: i64,
    position_bids: i64,
    position_asks: i64,
) -> DriftResult<bool> {
    if order.reduce_only {
        return Ok(false);
    }

    match order.direction {
        PositionDirection::Long => {
            if position_base_asset_amount >= 0 {
                return Ok(true);
            }

            Ok(position_bids.safe_add(order.base_asset_amount.cast()?)?
                > position_base_asset_amount.abs())
        }
        PositionDirection::Short => {
            if position_base_asset_amount <= 0 {
                return Ok(true);
            }

            Ok(position_asks
                .safe_sub(order.base_asset_amount.cast()?)?
                .abs()
                > position_base_asset_amount)
        }
    }
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

    let fill_price = calculate_fill_price(
        rounded_quote_asset_amount,
        base_asset_amount,
        base_precision,
    )?;

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

pub fn calculate_fill_price(
    quote_asset_amount: u64,
    base_asset_amount: u64,
    base_precision: u64,
) -> DriftResult<u64> {
    quote_asset_amount
        .cast::<u128>()?
        .safe_mul(base_precision as u128)?
        .safe_div(base_asset_amount.cast()?)?
        .cast::<u64>()
}

pub fn get_max_fill_amounts(
    user: &User,
    user_order_index: usize,
    base_market: &SpotMarket,
    quote_market: &SpotMarket,
    is_leaving_drift: bool,
) -> DriftResult<(Option<u64>, Option<u64>)> {
    let direction: PositionDirection = user.orders[user_order_index].direction;
    match direction {
        PositionDirection::Long => {
            let max_quote = get_max_fill_amounts_for_market(user, quote_market, is_leaving_drift)?
                .cast::<u64>()?;
            Ok((None, Some(max_quote)))
        }
        PositionDirection::Short => {
            let max_base = standardize_base_asset_amount(
                get_max_fill_amounts_for_market(user, base_market, is_leaving_drift)?
                    .cast::<u64>()?,
                base_market.order_step_size,
            )?;
            Ok((Some(max_base), None))
        }
    }
}

fn get_max_fill_amounts_for_market(
    user: &User,
    market: &SpotMarket,
    is_leaving_drift: bool,
) -> DriftResult<u128> {
    let position_index = user.get_spot_position_index(market.market_index)?;
    let token_amount = user.spot_positions[position_index].get_signed_token_amount(market)?;
    get_max_withdraw_for_market_with_token_amount(market, token_amount, is_leaving_drift)
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
    let MarginCalculation {
        margin_requirement,
        total_collateral,
        ..
    } = calculate_margin_requirement_and_total_collateral_and_liability_info(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        MarginContext::standard(MarginRequirementType::Initial).strict(true),
    )?;

    let user_custom_margin_ratio = user.max_margin_ratio;

    let free_collateral = total_collateral.safe_sub(margin_requirement.cast()?)?;

    let perp_market = perp_market_map.get_ref(&market_index)?;

    let oracle_price_data_price = oracle_map.get_price_data(&perp_market.amm.oracle)?.price;

    let quote_spot_market = spot_market_map.get_ref(&perp_market.quote_spot_market_index)?;
    let quote_oracle_price = oracle_map
        .get_price_data(&quote_spot_market.oracle)?
        .price
        .max(
            quote_spot_market
                .historical_oracle_data
                .last_oracle_price_twap_5min,
        );
    drop(quote_spot_market);

    let perp_position: &PerpPosition = &user.perp_positions[position_index];
    let base_asset_amount = perp_position.base_asset_amount;
    let worst_case_base_asset_amount = perp_position.worst_case_base_asset_amount()?;

    let margin_ratio = perp_market
        .get_margin_ratio(
            worst_case_base_asset_amount.unsigned_abs(),
            MarginRequirementType::Initial,
        )?
        .max(user_custom_margin_ratio);

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

    let calculate_order_size_and_margin_ratio = |margin_ratio: u32| {
        let new_order_size = free_collateral
            .safe_sub(OPEN_ORDER_MARGIN_REQUIREMENT.cast()?)?
            .safe_mul(BASE_PRECISION_I128 / QUOTE_PRECISION_I128)?
            .safe_mul(MARGIN_PRECISION_U128.cast()?)?
            .safe_div(margin_ratio.cast()?)?
            .safe_mul(PRICE_PRECISION_I128)?
            .safe_div(oracle_price_data_price.cast()?)?
            .safe_mul(PRICE_PRECISION_I128)?
            .safe_div(quote_oracle_price.cast()?)?
            .cast::<u64>()?;

        let new_margin_ratio = perp_market
            .get_margin_ratio(
                worst_case_base_asset_amount
                    .unsigned_abs()
                    .safe_add(new_order_size.cast()?)?,
                MarginRequirementType::Initial,
            )?
            .max(user_custom_margin_ratio);

        Ok((new_order_size, new_margin_ratio))
    };

    let mut order_size = 0_u64;
    let mut updated_margin_ratio = margin_ratio;
    for _ in 0..6 {
        let (new_order_size, new_margin_ratio) =
            calculate_order_size_and_margin_ratio(updated_margin_ratio)?;
        order_size = new_order_size;
        updated_margin_ratio = new_margin_ratio;

        if new_margin_ratio == margin_ratio {
            break;
        }
    }

    standardize_base_asset_amount(
        order_size.safe_add(order_size_to_flip)?,
        perp_market.amm.order_step_size,
    )
}

#[allow(clippy::unwrap_used)]
pub fn calculate_max_spot_order_size(
    user: &User,
    market_index: u16,
    direction: PositionDirection,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> DriftResult<u64> {
    // calculate initial margin requirement
    let MarginCalculation {
        margin_requirement,
        total_collateral,
        ..
    } = calculate_margin_requirement_and_total_collateral_and_liability_info(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        MarginContext::standard(MarginRequirementType::Initial).strict(true),
    )?;

    let user_custom_margin_ratio = user.max_margin_ratio;
    let user_custom_liability_weight = user.max_margin_ratio.saturating_add(SPOT_WEIGHT_PRECISION);
    let user_custom_asset_weight = SPOT_WEIGHT_PRECISION.saturating_sub(user_custom_margin_ratio);

    let mut order_size_to_flip = 0_u64;
    let free_collateral = total_collateral.safe_sub(margin_requirement.cast()?)?;

    let spot_market = spot_market_map.get_ref(&market_index)?;

    let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle)?;
    let twap = spot_market
        .historical_oracle_data
        .last_oracle_price_twap_5min;
    let strict_oracle_price = StrictOraclePrice::new(oracle_price_data.price, twap, true);
    let max_oracle_price = strict_oracle_price.max();

    let spot_position = user.get_spot_position(market_index)?;
    let signed_token_amount = spot_position.get_signed_token_amount(&spot_market)?;

    let [bid_simulation, ask_simulation] = spot_position
        .simulate_fills_both_sides(
            &spot_market,
            &strict_oracle_price,
            Some(signed_token_amount),
            MarginRequirementType::Initial,
        )?
        .map(|simulation| {
            simulation
                .apply_user_custom_margin_ratio(
                    &spot_market,
                    strict_oracle_price.current,
                    user_custom_margin_ratio,
                )
                .unwrap()
        });

    let OrderFillSimulation {
        token_amount: mut worst_case_token_amount,
        ..
    } = OrderFillSimulation::riskier_side(ask_simulation, bid_simulation);

    // account for order flipping worst case
    if worst_case_token_amount < 0 && direction == PositionDirection::Long {
        // to determine order size to flip direction, need to know diff in free collateral
        let mut free_collateral_difference = bid_simulation
            .free_collateral_contribution
            .safe_sub(ask_simulation.free_collateral_contribution)?
            .max(0)
            .abs();

        let mut token_amount = bid_simulation.token_amount;

        // the free collateral delta is positive until the worst case hits 0
        if token_amount < 0 {
            let token_value =
                get_strict_token_value(token_amount, spot_market.decimals, &strict_oracle_price)?;

            let liability_weight = spot_market
                .get_liability_weight(token_amount.unsigned_abs(), &MarginRequirementType::Initial)?
                .max(user_custom_liability_weight);

            let free_collateral_regained = token_value
                .abs()
                .safe_mul(liability_weight.safe_sub(SPOT_WEIGHT_PRECISION)?.cast()?)?
                .safe_div(SPOT_WEIGHT_PRECISION_I128)?;

            free_collateral_difference =
                free_collateral_difference.safe_add(free_collateral_regained)?;

            order_size_to_flip = token_amount.abs().cast()?;
            token_amount = 0;
        }

        // free collateral delta is negative as the worst case goes above 0
        let weight = spot_market
            .get_asset_weight(
                token_amount.unsigned_abs(),
                strict_oracle_price.current,
                &MarginRequirementType::Initial,
            )?
            .min(user_custom_asset_weight);

        let free_collateral_delta_per_order = weight
            .cast::<i128>()?
            .safe_sub(SPOT_WEIGHT_PRECISION_I128)?
            .abs()
            .safe_mul(max_oracle_price.cast()?)?
            .safe_div(PRICE_PRECISION_I128)?
            .safe_mul(QUOTE_PRECISION_I128)?
            .safe_div(SPOT_WEIGHT_PRECISION_I128)?;

        order_size_to_flip = order_size_to_flip.safe_add(
            free_collateral_difference
                .safe_mul(spot_market.get_precision().cast()?)?
                .safe_div(free_collateral_delta_per_order)?
                .cast::<u64>()?,
        )?;

        worst_case_token_amount = token_amount.safe_sub(order_size_to_flip.cast()?)?;
    } else if worst_case_token_amount > 0 && direction == PositionDirection::Short {
        let mut free_collateral_difference = ask_simulation
            .free_collateral_contribution
            .safe_sub(bid_simulation.free_collateral_contribution)?
            .max(0)
            .abs();

        let mut token_amount = ask_simulation.token_amount;

        if token_amount > 0 {
            let token_value =
                get_strict_token_value(token_amount, spot_market.decimals, &strict_oracle_price)?;

            let asset_weight = spot_market
                .get_asset_weight(
                    token_amount.unsigned_abs(),
                    strict_oracle_price.current,
                    &MarginRequirementType::Initial,
                )?
                .min(user_custom_asset_weight);

            let free_collateral_regained = token_value
                .abs()
                .safe_mul(SPOT_WEIGHT_PRECISION.safe_sub(asset_weight)?.cast()?)?
                .safe_div(SPOT_WEIGHT_PRECISION_I128)?;

            free_collateral_difference =
                free_collateral_difference.safe_add(free_collateral_regained)?;

            order_size_to_flip = token_amount.abs().cast()?;
            token_amount = 0;
        }

        let weight = spot_market
            .get_liability_weight(token_amount.unsigned_abs(), &MarginRequirementType::Initial)?
            .max(user_custom_liability_weight);

        let free_collateral_delta_per_order = weight
            .cast::<i128>()?
            .safe_sub(SPOT_WEIGHT_PRECISION_I128)?
            .abs()
            .safe_mul(max_oracle_price.cast()?)?
            .safe_div(PRICE_PRECISION_I128)?
            .safe_mul(QUOTE_PRECISION_I128)?
            .safe_div(SPOT_WEIGHT_PRECISION_I128)?;

        order_size_to_flip = order_size_to_flip.safe_add(
            free_collateral_difference
                .safe_mul(spot_market.get_precision().cast()?)?
                .safe_div(free_collateral_delta_per_order)?
                .cast::<u64>()?,
        )?;

        worst_case_token_amount = token_amount.safe_sub(order_size_to_flip.cast()?)?;
    }

    if free_collateral <= 0 {
        return standardize_base_asset_amount(order_size_to_flip, spot_market.order_step_size);
    }

    let free_collateral_delta = calculate_free_collateral_delta_for_spot(
        &spot_market,
        worst_case_token_amount.unsigned_abs(),
        &strict_oracle_price,
        direction,
        user_custom_liability_weight,
        user_custom_asset_weight,
    )?;

    let precision_increase = 10i128.pow(spot_market.decimals - 6);

    let calculate_order_size_and_free_collateral_delta = |free_collateral_delta: u32| {
        let new_order_size = free_collateral
            .safe_sub(OPEN_ORDER_MARGIN_REQUIREMENT.cast()?)?
            .safe_mul(precision_increase)?
            .safe_mul(SPOT_WEIGHT_PRECISION.cast()?)?
            .safe_div(free_collateral_delta.cast()?)?
            .safe_mul(PRICE_PRECISION_I128)?
            .safe_div(max_oracle_price.cast()?)?
            .cast::<u64>()?;

        // increasing the worst case token amount with new order size may increase margin ratio,
        // so need to recalculate free collateral delta with updated margin ratio
        let new_free_collateral_delta = calculate_free_collateral_delta_for_spot(
            &spot_market,
            worst_case_token_amount
                .unsigned_abs()
                .safe_add(new_order_size.cast()?)?,
            &strict_oracle_price,
            direction,
            user_custom_liability_weight,
            user_custom_asset_weight,
        )?;

        Ok((new_order_size, new_free_collateral_delta))
    };

    let mut order_size = 0_u64;
    let mut updated_free_collateral_delta = free_collateral_delta;
    for _ in 0..6 {
        let (new_order_size, new_free_collateral_delta) =
            calculate_order_size_and_free_collateral_delta(updated_free_collateral_delta)?;
        order_size = new_order_size;
        updated_free_collateral_delta = new_free_collateral_delta;

        if updated_free_collateral_delta == free_collateral_delta {
            break;
        }
    }

    standardize_base_asset_amount(
        order_size.safe_add(order_size_to_flip)?,
        spot_market.order_step_size,
    )
}

fn calculate_free_collateral_delta_for_spot(
    spot_market: &SpotMarket,
    worst_case_token_amount: u128,
    strict_oracle_price: &StrictOraclePrice,
    order_direction: PositionDirection,
    user_custom_liability_weight: u32,
    user_custom_asset_weight: u32,
) -> DriftResult<u32> {
    Ok(if order_direction == PositionDirection::Long {
        SPOT_WEIGHT_PRECISION.sub(
            spot_market
                .get_asset_weight(
                    worst_case_token_amount,
                    strict_oracle_price.current,
                    &MarginRequirementType::Initial,
                )?
                .min(user_custom_asset_weight),
        )
    } else {
        spot_market
            .get_liability_weight(worst_case_token_amount, &MarginRequirementType::Initial)?
            .max(user_custom_liability_weight)
            .sub(SPOT_WEIGHT_PRECISION)
    })
}

#[derive(Eq, PartialEq, Debug)]
pub struct Level {
    pub price: u64,
    pub base_asset_amount: u64,
}

pub fn find_bids_and_asks_from_users(
    perp_market: &PerpMarket,
    oracle_price_date: &OraclePriceData,
    users: &UserMap,
    slot: u64,
    now: i64,
) -> DriftResult<(Vec<Level>, Vec<Level>)> {
    let mut bids: Vec<Level> = Vec::with_capacity(32);
    let mut asks: Vec<Level> = Vec::with_capacity(32);

    let market_index = perp_market.market_index;
    let tick_size = perp_market.amm.order_tick_size;
    let oracle_price = Some(oracle_price_date.price);

    let mut insert_order = |base_asset_amount: u64, price: u64, direction: PositionDirection| {
        let orders = match direction {
            PositionDirection::Long => &mut bids,
            PositionDirection::Short => &mut asks,
        };
        let index = match orders.binary_search_by(|level| match direction {
            PositionDirection::Long => price.cmp(&level.price),
            PositionDirection::Short => level.price.cmp(&price),
        }) {
            Ok(index) => index,
            Err(index) => index,
        };

        if index < orders.capacity() {
            if orders.len() == orders.capacity() {
                orders.pop();
            }

            orders.insert(
                index,
                Level {
                    price,
                    base_asset_amount,
                },
            );
        }
    };

    for account_loader in users.0.values() {
        let user = load!(account_loader)?;

        for (_, order) in user.orders.iter().enumerate() {
            if order.status != OrderStatus::Open {
                continue;
            }

            if order.market_type != MarketType::Perp || order.market_index != market_index {
                continue;
            }

            // if order is not limit order or must be triggered and not triggered, skip
            if !order.is_limit_order() || (order.must_be_triggered() && !order.triggered()) {
                continue;
            }

            if !order.is_resting_limit_order(slot)? {
                continue;
            }

            if now > order.max_ts && order.max_ts != 0 {
                continue;
            }

            let existing_position = user.get_perp_position(market_index)?.base_asset_amount;
            let base_amount = order.get_base_asset_amount_unfilled(Some(existing_position))?;
            let limit_price = order.force_get_limit_price(oracle_price, None, slot, tick_size)?;

            insert_order(base_amount, limit_price, order.direction);
        }
    }

    Ok((bids, asks))
}

pub fn estimate_price_from_side(side: &Vec<Level>, depth: u64) -> DriftResult<Option<u64>> {
    let mut depth_remaining = depth;
    let mut cumulative_base = 0_u64;
    let mut cumulative_quote = 0_u128;

    for level in side {
        let base_delta = level.base_asset_amount.min(depth_remaining);
        let quote_delta = level.price.cast::<u128>()?.safe_mul(base_delta.cast()?)?;

        cumulative_base = cumulative_base.safe_add(base_delta)?;
        depth_remaining = depth_remaining.safe_sub(base_delta)?;
        cumulative_quote = cumulative_quote.safe_add(quote_delta)?;

        if depth_remaining == 0 {
            break;
        }
    }

    let price = if depth_remaining == 0 {
        Some(
            cumulative_quote
                .safe_div(cumulative_base.cast()?)?
                .cast::<u64>()?,
        )
    } else {
        None
    };

    Ok(price)
}

pub fn select_margin_type_for_perp_maker(
    maker: &User,
    base_asset_amount_filled: i64,
    market_index: u16,
) -> DriftResult<MarginRequirementType> {
    let position_after_fill = maker
        .get_perp_position(market_index)
        .map_or(0, |p| p.base_asset_amount);
    let position_before = position_after_fill.safe_sub(base_asset_amount_filled)?;

    if position_after_fill == 0 {
        return Ok(MarginRequirementType::Maintenance);
    }

    if position_after_fill.signum() == position_before.signum()
        && position_after_fill.abs() < position_before.abs()
    {
        return Ok(MarginRequirementType::Maintenance);
    }

    Ok(MarginRequirementType::Fill)
}
