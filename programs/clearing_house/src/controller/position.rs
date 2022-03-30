use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

use crate::controller;
use crate::controller::amm::SwapDirection;
use crate::error::*;
use crate::math::amm::should_round_trade;
use crate::math::casting::{cast, cast_to_i128};
use crate::math::collateral::calculate_updated_collateral;
use crate::math::orders::calculate_quote_asset_amount_for_maker_order;
use crate::math::pnl::calculate_pnl;
use crate::math::position::calculate_base_asset_value_and_pnl;
use crate::math_error;
use crate::{Market, MarketPosition, User, UserPositions};
use solana_program::msg;
use std::cell::RefMut;

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum PositionDirection {
    Long,
    Short,
}

impl Default for PositionDirection {
    // UpOnly
    fn default() -> Self {
        PositionDirection::Long
    }
}

pub fn add_new_position(
    user_positions: &mut RefMut<UserPositions>,
    market_index: u64,
) -> ClearingHouseResult<usize> {
    let new_position_index = user_positions
        .positions
        .iter()
        .position(|market_position| market_position.is_available())
        .ok_or(ErrorCode::MaxNumberOfPositions)?;

    let new_market_position = MarketPosition {
        market_index,
        base_asset_amount: 0,
        quote_asset_amount: 0,
        last_cumulative_funding_rate: 0,
        last_cumulative_repeg_rebate: 0,
        last_funding_rate_ts: 0,
        open_orders: 0,
        padding0: 0,
        padding1: 0,
        padding2: 0,
        padding3: 0,
        padding4: 0,
        padding5: 0,
        padding6: 0,
    };

    user_positions.positions[new_position_index] = new_market_position;

    Ok(new_position_index)
}

pub fn get_position_index(
    user_positions: &mut RefMut<UserPositions>,
    market_index: u64,
) -> ClearingHouseResult<usize> {
    let position_index = user_positions
        .positions
        .iter_mut()
        .position(|market_position| market_position.is_for(market_index));

    match position_index {
        Some(position_index) => Ok(position_index),
        None => Err(ErrorCode::UserHasNoPositionInMarket),
    }
}

pub fn increase(
    direction: PositionDirection,
    quote_asset_amount: u128,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<i128> {
    if quote_asset_amount == 0 {
        return Ok(0);
    }

    // Update funding rate if this is a new position
    if market_position.base_asset_amount == 0 {
        market_position.last_cumulative_funding_rate = match direction {
            PositionDirection::Long => market.amm.cumulative_funding_rate_long,
            PositionDirection::Short => market.amm.cumulative_funding_rate_short,
        };

        market.open_interest = market
            .open_interest
            .checked_add(1)
            .ok_or_else(math_error!())?;
    }

    market_position.quote_asset_amount = market_position
        .quote_asset_amount
        .checked_add(quote_asset_amount)
        .ok_or_else(math_error!())?;

    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Add,
        PositionDirection::Short => SwapDirection::Remove,
    };

    let base_asset_acquired = controller::amm::swap_quote_asset(
        &mut market.amm,
        quote_asset_amount,
        swap_direction,
        now,
        precomputed_mark_price,
    )?;

    // update the position size on market and user
    market_position.base_asset_amount = market_position
        .base_asset_amount
        .checked_add(base_asset_acquired)
        .ok_or_else(math_error!())?;
    market.base_asset_amount = market
        .base_asset_amount
        .checked_add(base_asset_acquired)
        .ok_or_else(math_error!())?;

    if market_position.base_asset_amount > 0 {
        market.base_asset_amount_long = market
            .base_asset_amount_long
            .checked_add(base_asset_acquired)
            .ok_or_else(math_error!())?;
    } else {
        market.base_asset_amount_short = market
            .base_asset_amount_short
            .checked_add(base_asset_acquired)
            .ok_or_else(math_error!())?;
    }

    Ok(base_asset_acquired)
}

pub fn increase_with_base_asset_amount(
    direction: PositionDirection,
    base_asset_amount: u128,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
    maker_limit_price: Option<u128>,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(u128, u128)> {
    if base_asset_amount == 0 {
        return Ok((0, 0));
    }

    // Update funding rate if this is a new position
    if market_position.base_asset_amount == 0 {
        market_position.last_cumulative_funding_rate = match direction {
            PositionDirection::Long => market.amm.cumulative_funding_rate_long,
            PositionDirection::Short => market.amm.cumulative_funding_rate_short,
        };

        market.open_interest = market
            .open_interest
            .checked_add(1)
            .ok_or_else(math_error!())?;
    }

    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Remove,
        PositionDirection::Short => SwapDirection::Add,
    };

    let quote_asset_swapped = controller::amm::swap_base_asset(
        &mut market.amm,
        base_asset_amount,
        swap_direction,
        now,
        precomputed_mark_price,
    )?;

    let (quote_asset_amount, quote_asset_amount_surplus) = match maker_limit_price {
        Some(limit_price) => calculate_quote_asset_amount_surplus(
            swap_direction,
            quote_asset_swapped,
            base_asset_amount,
            limit_price,
        )?,
        None => (quote_asset_swapped, 0),
    };

    market_position.quote_asset_amount = market_position
        .quote_asset_amount
        .checked_add(quote_asset_amount)
        .ok_or_else(math_error!())?;

    let base_asset_amount = match direction {
        PositionDirection::Long => cast_to_i128(base_asset_amount)?,
        PositionDirection::Short => -cast_to_i128(base_asset_amount)?,
    };

    market_position.base_asset_amount = market_position
        .base_asset_amount
        .checked_add(base_asset_amount)
        .ok_or_else(math_error!())?;
    market.base_asset_amount = market
        .base_asset_amount
        .checked_add(base_asset_amount)
        .ok_or_else(math_error!())?;

    if market_position.base_asset_amount > 0 {
        market.base_asset_amount_long = market
            .base_asset_amount_long
            .checked_add(base_asset_amount)
            .ok_or_else(math_error!())?;
    } else {
        market.base_asset_amount_short = market
            .base_asset_amount_short
            .checked_add(base_asset_amount)
            .ok_or_else(math_error!())?;
    }

    Ok((quote_asset_amount, quote_asset_amount_surplus))
}

pub fn reduce(
    direction: PositionDirection,
    quote_asset_swap_amount: u128,
    user: &mut User,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<i128> {
    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Add,
        PositionDirection::Short => SwapDirection::Remove,
    };

    let base_asset_swapped = controller::amm::swap_quote_asset(
        &mut market.amm,
        quote_asset_swap_amount,
        swap_direction,
        now,
        precomputed_mark_price,
    )?;

    let base_asset_amount_before = market_position.base_asset_amount;
    market_position.base_asset_amount = market_position
        .base_asset_amount
        .checked_add(base_asset_swapped)
        .ok_or_else(math_error!())?;

    market.open_interest = market
        .open_interest
        .checked_sub(cast(market_position.base_asset_amount == 0)?)
        .ok_or_else(math_error!())?;
    market.base_asset_amount = market
        .base_asset_amount
        .checked_add(base_asset_swapped)
        .ok_or_else(math_error!())?;

    if market_position.base_asset_amount > 0 {
        market.base_asset_amount_long = market
            .base_asset_amount_long
            .checked_add(base_asset_swapped)
            .ok_or_else(math_error!())?;
    } else {
        market.base_asset_amount_short = market
            .base_asset_amount_short
            .checked_add(base_asset_swapped)
            .ok_or_else(math_error!())?;
    }

    let base_asset_amount_change = base_asset_amount_before
        .checked_sub(market_position.base_asset_amount)
        .ok_or_else(math_error!())?
        .abs();

    let initial_quote_asset_amount_closed = market_position
        .quote_asset_amount
        .checked_mul(base_asset_amount_change.unsigned_abs())
        .ok_or_else(math_error!())?
        .checked_div(base_asset_amount_before.unsigned_abs())
        .ok_or_else(math_error!())?;

    market_position.quote_asset_amount = market_position
        .quote_asset_amount
        .checked_sub(initial_quote_asset_amount_closed)
        .ok_or_else(math_error!())?;

    let pnl = if market_position.base_asset_amount > 0 {
        cast_to_i128(quote_asset_swap_amount)?
            .checked_sub(cast(initial_quote_asset_amount_closed)?)
            .ok_or_else(math_error!())?
    } else {
        cast_to_i128(initial_quote_asset_amount_closed)?
            .checked_sub(cast(quote_asset_swap_amount)?)
            .ok_or_else(math_error!())?
    };

    user.collateral = calculate_updated_collateral(user.collateral, pnl)?;

    Ok(base_asset_swapped)
}

pub fn reduce_with_base_asset_amount(
    direction: PositionDirection,
    base_asset_amount: u128,
    user: &mut User,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
    maker_limit_price: Option<u128>,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(u128, u128)> {
    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Remove,
        PositionDirection::Short => SwapDirection::Add,
    };

    let quote_asset_swapped = controller::amm::swap_base_asset(
        &mut market.amm,
        base_asset_amount,
        swap_direction,
        now,
        precomputed_mark_price,
    )?;

    let (quote_asset_amount, quote_asset_amount_surplus) = match maker_limit_price {
        Some(limit_price) => calculate_quote_asset_amount_surplus(
            swap_direction,
            quote_asset_swapped,
            base_asset_amount,
            limit_price,
        )?,
        None => (quote_asset_swapped, 0),
    };

    let base_asset_amount = match direction {
        PositionDirection::Long => cast_to_i128(base_asset_amount)?,
        PositionDirection::Short => -cast_to_i128(base_asset_amount)?,
    };

    let base_asset_amount_before = market_position.base_asset_amount;
    market_position.base_asset_amount = market_position
        .base_asset_amount
        .checked_add(base_asset_amount)
        .ok_or_else(math_error!())?;

    market.open_interest = market
        .open_interest
        .checked_sub(cast(market_position.base_asset_amount == 0)?)
        .ok_or_else(math_error!())?;
    market.base_asset_amount = market
        .base_asset_amount
        .checked_add(base_asset_amount)
        .ok_or_else(math_error!())?;

    if market_position.base_asset_amount > 0 {
        market.base_asset_amount_long = market
            .base_asset_amount_long
            .checked_add(base_asset_amount)
            .ok_or_else(math_error!())?;
    } else {
        market.base_asset_amount_short = market
            .base_asset_amount_short
            .checked_add(base_asset_amount)
            .ok_or_else(math_error!())?;
    }

    let base_asset_amount_change = base_asset_amount_before
        .checked_sub(market_position.base_asset_amount)
        .ok_or_else(math_error!())?
        .abs();

    let initial_quote_asset_amount_closed = market_position
        .quote_asset_amount
        .checked_mul(base_asset_amount_change.unsigned_abs())
        .ok_or_else(math_error!())?
        .checked_div(base_asset_amount_before.unsigned_abs())
        .ok_or_else(math_error!())?;

    market_position.quote_asset_amount = market_position
        .quote_asset_amount
        .checked_sub(initial_quote_asset_amount_closed)
        .ok_or_else(math_error!())?;

    let pnl = if PositionDirection::Short == direction {
        cast_to_i128(quote_asset_amount)?
            .checked_sub(cast(initial_quote_asset_amount_closed)?)
            .ok_or_else(math_error!())?
    } else {
        cast_to_i128(initial_quote_asset_amount_closed)?
            .checked_sub(cast(quote_asset_amount)?)
            .ok_or_else(math_error!())?
    };

    user.collateral = calculate_updated_collateral(user.collateral, pnl)?;

    Ok((quote_asset_amount, quote_asset_amount_surplus))
}

pub fn close(
    user: &mut User,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
    maker_limit_price: Option<u128>,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(u128, i128, u128)> {
    // If user has no base asset, return early
    if market_position.base_asset_amount == 0 {
        return Ok((0, 0, 0));
    }

    let swap_direction = if market_position.base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };

    let quote_asset_swapped = controller::amm::swap_base_asset(
        &mut market.amm,
        market_position.base_asset_amount.unsigned_abs(),
        swap_direction,
        now,
        precomputed_mark_price,
    )?;

    let (quote_asset_amount, quote_asset_amount_surplus) = match maker_limit_price {
        Some(limit_price) => calculate_quote_asset_amount_surplus(
            swap_direction,
            quote_asset_swapped,
            market_position.base_asset_amount.unsigned_abs(),
            limit_price,
        )?,
        None => (quote_asset_swapped, 0),
    };

    let pnl = calculate_pnl(
        quote_asset_amount,
        market_position.quote_asset_amount,
        swap_direction,
    )?;

    user.collateral = calculate_updated_collateral(user.collateral, pnl)?;
    market_position.last_cumulative_funding_rate = 0;
    market_position.last_funding_rate_ts = 0;

    market.open_interest = market
        .open_interest
        .checked_sub(1)
        .ok_or_else(math_error!())?;

    market_position.quote_asset_amount = 0;

    market.base_asset_amount = market
        .base_asset_amount
        .checked_sub(market_position.base_asset_amount)
        .ok_or_else(math_error!())?;

    if market_position.base_asset_amount > 0 {
        market.base_asset_amount_long = market
            .base_asset_amount_long
            .checked_sub(market_position.base_asset_amount)
            .ok_or_else(math_error!())?;
    } else {
        market.base_asset_amount_short = market
            .base_asset_amount_short
            .checked_sub(market_position.base_asset_amount)
            .ok_or_else(math_error!())?;
    }

    let base_asset_amount = market_position.base_asset_amount;
    market_position.base_asset_amount = 0;

    Ok((
        quote_asset_amount,
        base_asset_amount,
        quote_asset_amount_surplus,
    ))
}

pub fn update_position_with_base_asset_amount(
    base_asset_amount: u128,
    direction: PositionDirection,
    market: &mut Market,
    user: &mut User,
    market_position: &mut MarketPosition,
    mark_price_before: u128,
    now: i64,
    maker_limit_price: Option<u128>,
) -> ClearingHouseResult<(bool, bool, u128, u128, u128)> {
    // A trade is risk increasing if it increases the users leverage
    // If a trade is risk increasing and brings the user's margin ratio below initial requirement
    // the trade fails
    // If a trade is risk increasing and it pushes the mark price too far away from the oracle price
    // the trade fails
    let mut potentially_risk_increasing = true;
    let mut reduce_only = false;

    // The trade increases the the user position if
    // 1) the user does not have a position
    // 2) the trade is in the same direction as the user's existing position
    let quote_asset_amount;
    let quote_asset_amount_surplus;
    let increase_position = market_position.base_asset_amount == 0
        || market_position.base_asset_amount > 0 && direction == PositionDirection::Long
        || market_position.base_asset_amount < 0 && direction == PositionDirection::Short;
    if increase_position {
        let (_quote_asset_amount, _quote_asset_amount_surplus) = increase_with_base_asset_amount(
            direction,
            base_asset_amount,
            market,
            market_position,
            now,
            maker_limit_price,
            Some(mark_price_before),
        )?;
        quote_asset_amount = _quote_asset_amount;
        quote_asset_amount_surplus = _quote_asset_amount_surplus;
    } else if market_position.base_asset_amount.unsigned_abs() > base_asset_amount {
        let (_quote_asset_amount, _quote_asset_amount_surplus) = reduce_with_base_asset_amount(
            direction,
            base_asset_amount,
            user,
            market,
            market_position,
            now,
            maker_limit_price,
            Some(mark_price_before),
        )?;
        quote_asset_amount = _quote_asset_amount;
        quote_asset_amount_surplus = _quote_asset_amount_surplus;

        reduce_only = true;
        potentially_risk_increasing = false;
    } else {
        // after closing existing position, how large should trade be in opposite direction
        let base_asset_amount_after_close = base_asset_amount
            .checked_sub(market_position.base_asset_amount.unsigned_abs())
            .ok_or_else(math_error!())?;

        // If the value of the new position is less than value of the old position, consider it risk decreasing
        if base_asset_amount_after_close < market_position.base_asset_amount.unsigned_abs() {
            potentially_risk_increasing = false;
        }

        let (quote_asset_amount_closed, _, quote_asset_amount_surplus_closed) =
            close(user, market, market_position, now, maker_limit_price, None)?;

        let (quote_asset_amount_opened, quote_asset_amount_surplus_opened) =
            increase_with_base_asset_amount(
                direction,
                base_asset_amount_after_close,
                market,
                market_position,
                now,
                maker_limit_price,
                Some(mark_price_before),
            )?;

        // means position was closed and it was reduce only
        if quote_asset_amount_opened == 0 {
            reduce_only = true;
        }

        quote_asset_amount = quote_asset_amount_closed
            .checked_add(quote_asset_amount_opened)
            .ok_or_else(math_error!())?;

        quote_asset_amount_surplus = quote_asset_amount_surplus_closed
            .checked_add(quote_asset_amount_surplus_opened)
            .ok_or_else(math_error!())?;
    }

    Ok((
        potentially_risk_increasing,
        reduce_only,
        base_asset_amount,
        quote_asset_amount,
        quote_asset_amount_surplus,
    ))
}

pub fn update_position_with_quote_asset_amount(
    quote_asset_amount: u128,
    direction: PositionDirection,
    market: &mut Market,
    user: &mut User,
    market_position: &mut MarketPosition,
    mark_price_before: u128,
    now: i64,
) -> ClearingHouseResult<(bool, bool, u128, u128, u128)> {
    // A trade is risk increasing if it increases the users leverage
    // If a trade is risk increasing and brings the user's margin ratio below initial requirement
    // the trade fails
    // If a trade is risk increasing and it pushes the mark price too far away from the oracle price
    // the trade fails
    let mut potentially_risk_increasing = true;
    let mut reduce_only = false;

    let mut quote_asset_amount = quote_asset_amount;
    let base_asset_amount;
    // The trade increases the the user position if
    // 1) the user does not have a position
    // 2) the trade is in the same direction as the user's existing position
    let increase_position = market_position.base_asset_amount == 0
        || market_position.base_asset_amount > 0 && direction == PositionDirection::Long
        || market_position.base_asset_amount < 0 && direction == PositionDirection::Short;
    if increase_position {
        base_asset_amount = controller::position::increase(
            direction,
            quote_asset_amount,
            market,
            market_position,
            now,
            Some(mark_price_before),
        )?
        .unsigned_abs();
    } else {
        let (base_asset_value, _unrealized_pnl) =
            calculate_base_asset_value_and_pnl(market_position, &market.amm)?;

        // if the quote_asset_amount is close enough in value to base_asset_value,
        // round the quote_asset_amount to be the same as base_asset_value
        if should_round_trade(&market.amm, quote_asset_amount, base_asset_value)? {
            quote_asset_amount = base_asset_value;
        }

        // we calculate what the user's position is worth if they closed to determine
        // if they are reducing or closing and reversing their position
        if base_asset_value > quote_asset_amount {
            base_asset_amount = controller::position::reduce(
                direction,
                quote_asset_amount,
                user,
                market,
                market_position,
                now,
                Some(mark_price_before),
            )?
            .unsigned_abs();

            potentially_risk_increasing = false;
            reduce_only = true;
        } else {
            // after closing existing position, how large should trade be in opposite direction
            let quote_asset_amount_after_close = quote_asset_amount
                .checked_sub(base_asset_value)
                .ok_or_else(math_error!())?;

            // If the value of the new position is less than value of the old position, consider it risk decreasing
            if quote_asset_amount_after_close < base_asset_value {
                potentially_risk_increasing = false;
            }

            let (_, base_asset_amount_closed, _) = controller::position::close(
                user,
                market,
                market_position,
                now,
                None,
                Some(mark_price_before),
            )?;
            let base_asset_amount_closed = base_asset_amount_closed.unsigned_abs();

            let base_asset_amount_opened = controller::position::increase(
                direction,
                quote_asset_amount_after_close,
                market,
                market_position,
                now,
                Some(mark_price_before),
            )?
            .unsigned_abs();

            // means position was closed and it was reduce only
            if base_asset_amount_opened == 0 {
                reduce_only = true;
            }

            base_asset_amount = base_asset_amount_closed
                .checked_add(base_asset_amount_opened)
                .ok_or_else(math_error!())?;
        }
    }

    Ok((
        potentially_risk_increasing,
        reduce_only,
        base_asset_amount,
        quote_asset_amount,
        0,
    ))
}

fn calculate_quote_asset_amount_surplus(
    swap_direction: SwapDirection,
    quote_asset_swapped: u128,
    base_asset_amount: u128,
    limit_price: u128,
) -> ClearingHouseResult<(u128, u128)> {
    let quote_asset_amount =
        calculate_quote_asset_amount_for_maker_order(base_asset_amount, limit_price)?;

    let quote_asset_amount_surplus = match swap_direction {
        SwapDirection::Remove => quote_asset_amount
            .checked_sub(quote_asset_swapped)
            .ok_or_else(math_error!())?,
        SwapDirection::Add => quote_asset_swapped
            .checked_sub(quote_asset_amount)
            .ok_or_else(math_error!())?,
    };

    Ok((quote_asset_amount, quote_asset_amount_surplus))
}
