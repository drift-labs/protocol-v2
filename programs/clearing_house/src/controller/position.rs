use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

use crate::controller;
use crate::controller::amm::SwapDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::amm::should_round_trade;
use crate::math::casting::{cast, cast_to_i128};
use crate::math::orders::calculate_quote_asset_amount_for_maker_order;
use crate::math::pnl::calculate_pnl;
use crate::math::position::{calculate_base_asset_value_and_pnl, swap_direction_to_close_position};
use crate::math_error;
use crate::state::market::Market;
use crate::state::user::{User, UserPositions};
use crate::MarketPosition;
use solana_program::msg;
use std::cmp::min;

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
    user_positions: &mut UserPositions,
    market_index: u64,
) -> ClearingHouseResult<usize> {
    let new_position_index = user_positions
        .iter()
        .position(|market_position| market_position.is_available())
        .ok_or(ErrorCode::MaxNumberOfPositions)?;

    let new_market_position = MarketPosition {
        market_index,
        base_asset_amount: 0,
        quote_asset_amount: 0,
        quote_entry_amount: 0,
        last_cumulative_funding_rate: 0,
        last_cumulative_repeg_rebate: 0,
        last_funding_rate_ts: 0,
        open_orders: 0,
        unsettled_pnl: 0,
        padding0: 0,
        padding1: 0,
        padding2: 0,
        padding3: 0,
        padding4: 0,
        padding5: 0,
        padding6: 0,
    };

    user_positions[new_position_index] = new_market_position;

    Ok(new_position_index)
}

pub fn get_position_index(
    user_positions: &UserPositions,
    market_index: u64,
) -> ClearingHouseResult<usize> {
    let position_index = user_positions
        .iter()
        .position(|market_position| market_position.is_for(market_index));

    match position_index {
        Some(position_index) => Ok(position_index),
        None => Err(ErrorCode::UserHasNoPositionInMarket),
    }
}

pub struct PositionDelta {
    quote_asset_amount: u128,
    base_asset_amount: i128,
}

pub fn update_position_and_market(
    position: &mut MarketPosition,
    market: &mut Market,
    delta: &PositionDelta,
) -> ClearingHouseResult<i128> {
    let new_position = position.base_asset_amount == 0;
    let increasing_position =
        new_position || position.base_asset_amount.signum() == delta.base_asset_amount.signum();

    let (new_quote_asset_amount, new_quote_entry_amount, new_base_asset_amount, pnl) =
        if !increasing_position {
            let base_asset_amount_before_unsigned = position.base_asset_amount.unsigned_abs();
            let delta_base_asset_amount_unsigned = delta.base_asset_amount.unsigned_abs();

            let cost_basis = position
                .quote_asset_amount
                .checked_mul(min(
                    delta_base_asset_amount_unsigned,
                    base_asset_amount_before_unsigned,
                ))
                .ok_or_else(math_error!())?
                .checked_div(base_asset_amount_before_unsigned)
                .ok_or_else(math_error!())?;

            let exit_value = delta
                .quote_asset_amount
                .checked_mul(min(
                    delta_base_asset_amount_unsigned,
                    base_asset_amount_before_unsigned,
                ))
                .ok_or_else(math_error!())?
                .checked_div(delta_base_asset_amount_unsigned)
                .ok_or_else(math_error!())?;

            let pnl = calculate_pnl(
                exit_value,
                cost_basis,
                swap_direction_to_close_position(position.base_asset_amount),
            )?;

            let new_base_asset_amount = position
                .base_asset_amount
                .checked_add(delta.base_asset_amount)
                .ok_or_else(math_error!())?;

            let (new_quote_asset_amount, new_quote_entry_amount) =
                if delta.quote_asset_amount > exit_value {
                    let new_quote_asset_amount = delta
                        .quote_asset_amount
                        .checked_sub(exit_value)
                        .ok_or_else(math_error!())?;
                    (new_quote_asset_amount, new_quote_asset_amount)
                } else {
                    let entry_amount_delta = position
                        .quote_entry_amount
                        .checked_mul(delta_base_asset_amount_unsigned)
                        .ok_or_else(math_error!())?
                        .checked_div(base_asset_amount_before_unsigned)
                        .ok_or_else(math_error!())?;

                    let quote_entry_amount = position
                        .quote_entry_amount
                        .checked_sub(entry_amount_delta)
                        .ok_or_else(math_error!())?;

                    (
                        position
                            .quote_asset_amount
                            .checked_sub(cost_basis)
                            .ok_or_else(math_error!())?,
                        quote_entry_amount,
                    )
                };

            (
                new_quote_asset_amount,
                new_quote_entry_amount,
                new_base_asset_amount,
                pnl,
            )
        } else {
            let new_quote_asset_amount = position
                .quote_asset_amount
                .checked_add(delta.quote_asset_amount)
                .ok_or_else(math_error!())?;
            let new_quote_entry_amount = position
                .quote_entry_amount
                .checked_add(delta.quote_asset_amount)
                .ok_or_else(math_error!())?;
            let new_base_asset_amount = position
                .base_asset_amount
                .checked_add(delta.base_asset_amount)
                .ok_or_else(math_error!())?;

            (
                new_quote_asset_amount,
                new_quote_entry_amount,
                new_base_asset_amount,
                0_i128,
            )
        };

    let reduced_position = !increasing_position
        && position.base_asset_amount.signum() == new_base_asset_amount.signum();
    let closed_position = new_base_asset_amount == 0;
    let flipped_position = position.base_asset_amount.signum() != new_base_asset_amount.signum();

    // Update Market
    market.amm.net_base_asset_amount = market
        .amm
        .net_base_asset_amount
        .checked_add(delta.base_asset_amount)
        .ok_or_else(math_error!())?;

    // Update Market open interest
    if new_position {
        market.open_interest = market
            .open_interest
            .checked_add(1)
            .ok_or_else(math_error!())?;
    } else if closed_position {
        market.open_interest = market
            .open_interest
            .checked_sub(1)
            .ok_or_else(math_error!())?;
    }

    if increasing_position {
        if new_base_asset_amount > 0 {
            market.base_asset_amount_long = market
                .base_asset_amount_long
                .checked_add(delta.base_asset_amount)
                .ok_or_else(math_error!())?;
            market.amm.quote_asset_amount_long = market
                .amm
                .quote_asset_amount_long
                .checked_add(delta.quote_asset_amount)
                .ok_or_else(math_error!())?;
        } else {
            market.base_asset_amount_short = market
                .base_asset_amount_short
                .checked_add(delta.base_asset_amount)
                .ok_or_else(math_error!())?;
            market.amm.quote_asset_amount_short = market
                .amm
                .quote_asset_amount_short
                .checked_add(delta.quote_asset_amount)
                .ok_or_else(math_error!())?;
        }
    } else if reduced_position || closed_position {
        if position.base_asset_amount > 0 {
            market.base_asset_amount_long = market
                .base_asset_amount_long
                .checked_add(delta.base_asset_amount)
                .ok_or_else(math_error!())?;
            market.amm.quote_asset_amount_long = market
                .amm
                .quote_asset_amount_long
                .checked_sub(
                    position
                        .quote_asset_amount
                        .checked_sub(new_quote_asset_amount)
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?;
        } else {
            market.base_asset_amount_short = market
                .base_asset_amount_short
                .checked_add(delta.base_asset_amount)
                .ok_or_else(math_error!())?;
            market.amm.quote_asset_amount_short = market
                .amm
                .quote_asset_amount_short
                .checked_sub(
                    position
                        .quote_asset_amount
                        .checked_sub(new_quote_asset_amount)
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?;
        }
    } else if flipped_position {
        if new_base_asset_amount > 0 {
            market.base_asset_amount_short = market
                .base_asset_amount_short
                .checked_sub(position.base_asset_amount)
                .ok_or_else(math_error!())?;
            market.base_asset_amount_long = market
                .base_asset_amount_long
                .checked_add(new_base_asset_amount)
                .ok_or_else(math_error!())?;

            market.amm.quote_asset_amount_short = market
                .amm
                .quote_asset_amount_short
                .checked_sub(position.quote_asset_amount)
                .ok_or_else(math_error!())?;
            market.amm.quote_asset_amount_long = market
                .amm
                .quote_asset_amount_long
                .checked_add(new_quote_asset_amount)
                .ok_or_else(math_error!())?;
        } else {
            market.base_asset_amount_long = market
                .base_asset_amount_long
                .checked_sub(position.base_asset_amount)
                .ok_or_else(math_error!())?;
            market.base_asset_amount_short = market
                .base_asset_amount_short
                .checked_add(new_base_asset_amount)
                .ok_or_else(math_error!())?;

            market.amm.quote_asset_amount_long = market
                .amm
                .quote_asset_amount_long
                .checked_sub(position.quote_asset_amount)
                .ok_or_else(math_error!())?;
            market.amm.quote_asset_amount_short = market
                .amm
                .quote_asset_amount_short
                .checked_add(new_quote_asset_amount)
                .ok_or_else(math_error!())?;
        }
    }

    // Update user position
    if closed_position {
        position.last_cumulative_funding_rate = 0;
        position.last_funding_rate_ts = 0;
    } else if new_position || flipped_position {
        if new_base_asset_amount > 0 {
            position.last_cumulative_funding_rate = market.amm.cumulative_funding_rate_long;
        } else {
            position.last_cumulative_funding_rate = market.amm.cumulative_funding_rate_short;
        }
    }

    position.quote_asset_amount = new_quote_asset_amount;
    position.quote_entry_amount = new_quote_entry_amount;
    position.base_asset_amount = new_base_asset_amount;

    Ok(pnl)
}

pub fn increase(
    direction: PositionDirection,
    quote_asset_amount: u128,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(i128, u128)> {
    if quote_asset_amount == 0 {
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

    market_position.quote_asset_amount = market_position
        .quote_asset_amount
        .checked_add(quote_asset_amount)
        .ok_or_else(math_error!())?;

    market_position.quote_entry_amount = market_position
        .quote_entry_amount
        .checked_add(quote_asset_amount)
        .ok_or_else(math_error!())?;

    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Add,
        PositionDirection::Short => SwapDirection::Remove,
    };

    let (base_asset_acquired, quote_asset_amount_surplus) = controller::amm::swap_quote_asset(
        &mut market.amm,
        quote_asset_amount,
        swap_direction,
        now,
        precomputed_mark_price,
        true,
    )?;

    // update the position size on market and user
    market_position.base_asset_amount = market_position
        .base_asset_amount
        .checked_add(base_asset_acquired)
        .ok_or_else(math_error!())?;
    market.amm.net_base_asset_amount = market
        .amm
        .net_base_asset_amount
        .checked_add(base_asset_acquired)
        .ok_or_else(math_error!())?;

    if market_position.base_asset_amount > 0 {
        market.base_asset_amount_long = market
            .base_asset_amount_long
            .checked_add(base_asset_acquired)
            .ok_or_else(math_error!())?;
        market.amm.quote_asset_amount_long = market
            .amm
            .quote_asset_amount_long
            .checked_add(quote_asset_amount)
            .ok_or_else(math_error!())?;
    } else {
        market.base_asset_amount_short = market
            .base_asset_amount_short
            .checked_add(base_asset_acquired)
            .ok_or_else(math_error!())?;
        market.amm.quote_asset_amount_short = market
            .amm
            .quote_asset_amount_short
            .checked_add(quote_asset_amount)
            .ok_or_else(math_error!())?;
    }

    Ok((base_asset_acquired, quote_asset_amount_surplus))
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

    let (quote_asset_swapped, quote_asset_amount_surplus) = controller::amm::swap_base_asset(
        &mut market.amm,
        base_asset_amount,
        swap_direction,
        now,
        precomputed_mark_price,
        true,
    )?;

    let (quote_asset_amount, quote_asset_amount_surplus) = match maker_limit_price {
        Some(limit_price) => calculate_quote_asset_amount_surplus(
            swap_direction,
            quote_asset_swapped,
            base_asset_amount,
            limit_price,
        )?,
        None => (quote_asset_swapped, quote_asset_amount_surplus),
    };

    market_position.quote_asset_amount = market_position
        .quote_asset_amount
        .checked_add(quote_asset_amount)
        .ok_or_else(math_error!())?;
    market_position.quote_entry_amount = market_position
        .quote_entry_amount
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
    market.amm.net_base_asset_amount = market
        .amm
        .net_base_asset_amount
        .checked_add(base_asset_amount)
        .ok_or_else(math_error!())?;

    if market_position.base_asset_amount > 0 {
        market.base_asset_amount_long = market
            .base_asset_amount_long
            .checked_add(base_asset_amount)
            .ok_or_else(math_error!())?;
        market.amm.quote_asset_amount_long = market
            .amm
            .quote_asset_amount_long
            .checked_add(quote_asset_amount)
            .ok_or_else(math_error!())?;
    } else {
        market.base_asset_amount_short = market
            .base_asset_amount_short
            .checked_add(base_asset_amount)
            .ok_or_else(math_error!())?;
        market.amm.quote_asset_amount_short = market
            .amm
            .quote_asset_amount_short
            .checked_add(quote_asset_amount)
            .ok_or_else(math_error!())?;
    }

    Ok((quote_asset_amount, quote_asset_amount_surplus))
}

pub fn reduce(
    direction: PositionDirection,
    quote_asset_swap_amount: u128,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
    precomputed_mark_price: Option<u128>,
    use_spread: bool,
) -> ClearingHouseResult<(i128, u128, i128)> {
    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Add,
        PositionDirection::Short => SwapDirection::Remove,
    };

    let (base_asset_swapped, quote_asset_amount_surplus) = controller::amm::swap_quote_asset(
        &mut market.amm,
        quote_asset_swap_amount,
        swap_direction,
        now,
        precomputed_mark_price,
        use_spread,
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
    market.amm.net_base_asset_amount = market
        .amm
        .net_base_asset_amount
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

    market_position.quote_entry_amount = market_position
        .quote_entry_amount
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

    Ok((base_asset_swapped, quote_asset_amount_surplus, pnl))
}

pub fn reduce_with_base_asset_amount(
    direction: PositionDirection,
    base_asset_amount: u128,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
    maker_limit_price: Option<u128>,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(u128, u128, i128)> {
    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Remove,
        PositionDirection::Short => SwapDirection::Add,
    };

    let (quote_asset_swapped, quote_asset_amount_surplus) = controller::amm::swap_base_asset(
        &mut market.amm,
        base_asset_amount,
        swap_direction,
        now,
        precomputed_mark_price,
        maker_limit_price.is_none(),
    )?;

    let (quote_asset_amount, quote_asset_amount_surplus) = match maker_limit_price {
        Some(limit_price) => calculate_quote_asset_amount_surplus(
            swap_direction,
            quote_asset_swapped,
            base_asset_amount,
            limit_price,
        )?,
        None => (quote_asset_swapped, quote_asset_amount_surplus),
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
    market.amm.net_base_asset_amount = market
        .amm
        .net_base_asset_amount
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

    market_position.quote_entry_amount = market_position
        .quote_entry_amount
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

    Ok((quote_asset_amount, quote_asset_amount_surplus, pnl))
}

pub fn close(
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
    maker_limit_price: Option<u128>,
    precomputed_mark_price: Option<u128>,
    use_spread: bool,
) -> ClearingHouseResult<(u128, i128, u128, i128)> {
    // If user has no base asset, return early
    if market_position.base_asset_amount == 0 {
        return Ok((0, 0, 0, 0));
    }

    let swap_direction = if market_position.base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };

    let (quote_asset_swapped, quote_asset_amount_surplus) = controller::amm::swap_base_asset(
        &mut market.amm,
        market_position.base_asset_amount.unsigned_abs(),
        swap_direction,
        now,
        precomputed_mark_price,
        use_spread && maker_limit_price.is_none(),
    )?;

    let (quote_asset_amount, quote_asset_amount_surplus) = match maker_limit_price {
        Some(limit_price) => calculate_quote_asset_amount_surplus(
            swap_direction,
            quote_asset_swapped,
            market_position.base_asset_amount.unsigned_abs(),
            limit_price,
        )?,
        None => (quote_asset_swapped, quote_asset_amount_surplus),
    };

    let pnl = calculate_pnl(
        quote_asset_amount,
        market_position.quote_asset_amount,
        swap_direction,
    )?;

    market_position.last_cumulative_funding_rate = 0;
    market_position.last_funding_rate_ts = 0;

    market.open_interest = market
        .open_interest
        .checked_sub(1)
        .ok_or_else(math_error!())?;

    market_position.quote_asset_amount = 0;
    market_position.quote_entry_amount = 0;

    market.amm.net_base_asset_amount = market
        .amm
        .net_base_asset_amount
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
        pnl,
    ))
}

// pub fn update_position_with_base_asset_amount(
//     base_asset_amount: u128,
//     direction: PositionDirection,
//     market: &mut Market,
//     user: &mut User,
//     position_index: usize,
//     mark_price_before: u128,
//     now: i64,
//     maker_limit_price: Option<u128>,
// ) -> ClearingHouseResult<(bool, bool, u128, u128, u128, i128)> {
//     // A trade is risk increasing if it increases the users leverage
//     // If a trade is risk increasing and brings the user's margin ratio below initial requirement
//     // the trade fails
//     // If a trade is risk increasing and it pushes the mark price too far away from the oracle price
//     // the trade fails
//     let mut potentially_risk_increasing = true;
//     let mut reduce_only = false;
//
//     // The trade increases the the user position if
//     // 1) the user does not have a position
//     // 2) the trade is in the same direction as the user's existing position
//     let quote_asset_amount;
//     let quote_asset_amount_surplus;
//     let pnl;
//     let existing_base_asset_amount = user.positions[position_index].base_asset_amount;
//     let increase_position = existing_base_asset_amount == 0
//         || existing_base_asset_amount > 0 && direction == PositionDirection::Long
//         || existing_base_asset_amount < 0 && direction == PositionDirection::Short;
//     if increase_position {
//         let (_quote_asset_amount, _quote_asset_amount_surplus) = increase_with_base_asset_amount(
//             direction,
//             base_asset_amount,
//             market,
//             &mut user.positions[position_index],
//             now,
//             maker_limit_price,
//             Some(mark_price_before),
//         )?;
//         quote_asset_amount = _quote_asset_amount;
//         quote_asset_amount_surplus = _quote_asset_amount_surplus;
//         pnl = 0_i128;
//     } else if existing_base_asset_amount.unsigned_abs() > base_asset_amount {
//         let (_quote_asset_amount, _quote_asset_amount_surplus, _pnl) =
//             reduce_with_base_asset_amount(
//                 direction,
//                 base_asset_amount,
//                 market,
//                 &mut user.positions[position_index],
//                 now,
//                 maker_limit_price,
//                 Some(mark_price_before),
//             )?;
//         quote_asset_amount = _quote_asset_amount;
//         quote_asset_amount_surplus = _quote_asset_amount_surplus;
//         pnl = _pnl;
//
//         reduce_only = true;
//         potentially_risk_increasing = false;
//     } else {
//         // after closing existing position, how large should trade be in opposite direction
//         let base_asset_amount_after_close = base_asset_amount
//             .checked_sub(existing_base_asset_amount.unsigned_abs())
//             .ok_or_else(math_error!())?;
//
//         // If the value of the new position is less than value of the old position, consider it risk decreasing
//         if base_asset_amount_after_close < existing_base_asset_amount.unsigned_abs() {
//             potentially_risk_increasing = false;
//         }
//
//         let (quote_asset_amount_closed, _, quote_asset_amount_surplus_closed, _pnl) = close(
//             market,
//             &mut user.positions[position_index],
//             now,
//             maker_limit_price,
//             None,
//             true,
//         )?;
//
//         let (quote_asset_amount_opened, quote_asset_amount_surplus_opened) =
//             increase_with_base_asset_amount(
//                 direction,
//                 base_asset_amount_after_close,
//                 market,
//                 &mut user.positions[position_index],
//                 now,
//                 maker_limit_price,
//                 Some(mark_price_before),
//             )?;
//
//         // means position was closed and it was reduce only
//         if quote_asset_amount_opened == 0 {
//             reduce_only = true;
//         }
//
//         quote_asset_amount = quote_asset_amount_closed
//             .checked_add(quote_asset_amount_opened)
//             .ok_or_else(math_error!())?;
//
//         quote_asset_amount_surplus = quote_asset_amount_surplus_closed
//             .checked_add(quote_asset_amount_surplus_opened)
//             .ok_or_else(math_error!())?;
//
//         pnl = _pnl;
//     }
//
//     Ok((
//         potentially_risk_increasing,
//         reduce_only,
//         base_asset_amount,
//         quote_asset_amount,
//         quote_asset_amount_surplus,
//         pnl,
//     ))
// }

pub fn update_position_with_base_asset_amount(
    base_asset_amount: u128,
    direction: PositionDirection,
    market: &mut Market,
    user: &mut User,
    position_index: usize,
    mark_price_before: u128,
    now: i64,
    maker_limit_price: Option<u128>,
) -> ClearingHouseResult<(bool, bool, u128, u128, u128, i128)> {
    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Remove,
        PositionDirection::Short => SwapDirection::Add,
    };

    let (quote_asset_swapped, quote_asset_amount_surplus) = controller::amm::swap_base_asset(
        &mut market.amm,
        base_asset_amount,
        swap_direction,
        now,
        Some(mark_price_before),
        maker_limit_price.is_none(),
    )?;

    let (quote_asset_amount, quote_asset_amount_surplus) = match maker_limit_price {
        Some(limit_price) => calculate_quote_asset_amount_surplus(
            swap_direction,
            quote_asset_swapped,
            base_asset_amount,
            limit_price,
        )?,
        None => (quote_asset_swapped, quote_asset_amount_surplus),
    };

    let position_delta = PositionDelta {
        quote_asset_amount,
        base_asset_amount: match direction {
            PositionDirection::Long => cast_to_i128(base_asset_amount)?,
            PositionDirection::Short => -cast_to_i128(base_asset_amount)?,
        },
    };

    let base_asset_amount_before = user.positions[position_index].base_asset_amount;

    let potentially_risk_increasing = base_asset_amount_before == 0
        || base_asset_amount_before.signum() == position_delta.base_asset_amount.signum()
        || base_asset_amount_before.abs() < position_delta.base_asset_amount.abs();

    let reduce_only = !potentially_risk_increasing
        && base_asset_amount_before.signum() != position_delta.base_asset_amount.signum();

    let pnl =
        update_position_and_market(&mut user.positions[position_index], market, &position_delta)?;

    Ok((
        potentially_risk_increasing,
        reduce_only,
        base_asset_amount,
        quote_asset_amount,
        quote_asset_amount_surplus,
        pnl,
    ))
}

pub fn update_position_with_quote_asset_amount(
    quote_asset_amount: u128,
    direction: PositionDirection,
    market: &mut Market,
    user: &mut User,
    position_index: usize,
    mark_price_before: u128,
    now: i64,
) -> ClearingHouseResult<(bool, bool, u128, u128, u128, i128)> {
    // A trade is risk increasing if it increases the users leverage
    // If a trade is risk increasing and brings the user's margin ratio below initial requirement
    // the trade fails
    // If a trade is risk increasing and it pushes the mark price too far away from the oracle price
    // the trade fails
    let mut potentially_risk_increasing = true;
    let mut reduce_only = false;

    let mut quote_asset_amount = quote_asset_amount;
    let base_asset_amount;
    let quote_asset_amount_surplus;
    let pnl;
    // The trade increases the the user position if
    // 1) the user does not have a position
    // 2) the trade is in the same direction as the user's existing position
    let existing_base_asset_amount = user.positions[position_index].base_asset_amount;
    let increase_position = existing_base_asset_amount == 0
        || existing_base_asset_amount > 0 && direction == PositionDirection::Long
        || existing_base_asset_amount < 0 && direction == PositionDirection::Short;
    if increase_position {
        let market_position = &mut user.positions[position_index];
        let (_base_asset_amount, _quote_asset_amount_surplus) = controller::position::increase(
            direction,
            quote_asset_amount,
            market,
            market_position,
            now,
            Some(mark_price_before),
        )?;
        base_asset_amount = _base_asset_amount.unsigned_abs();
        quote_asset_amount_surplus = _quote_asset_amount_surplus;
        pnl = 0_i128;
    } else {
        let market_position = &mut user.positions[position_index];
        let (base_asset_value, _unrealized_pnl) =
            calculate_base_asset_value_and_pnl(market_position, &market.amm, true)?;

        // if the quote_asset_amount is close enough in value to base_asset_value,
        // round the quote_asset_amount to be the same as base_asset_value
        if should_round_trade(&market.amm, quote_asset_amount, base_asset_value)? {
            quote_asset_amount = base_asset_value;
        }

        // we calculate what the user's position is worth if they closed to determine
        // if they are reducing or closing and reversing their position
        if base_asset_value > quote_asset_amount {
            let (_base_asset_amount, _quote_asset_amount_surplus, _pnl) =
                controller::position::reduce(
                    direction,
                    quote_asset_amount,
                    market,
                    market_position,
                    now,
                    Some(mark_price_before),
                    true,
                )?;

            base_asset_amount = _base_asset_amount.unsigned_abs();
            quote_asset_amount_surplus = _quote_asset_amount_surplus;
            pnl = _pnl;

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

            let (_, base_asset_amount_closed, quote_asset_amount_surplus_closed, _pnl) =
                controller::position::close(
                    market,
                    market_position,
                    now,
                    None,
                    Some(mark_price_before),
                    true,
                )?;
            let base_asset_amount_closed = base_asset_amount_closed.unsigned_abs();

            let (base_asset_amount_opened, quote_asset_amount_surplus_opened) =
                controller::position::increase(
                    direction,
                    quote_asset_amount_after_close,
                    market,
                    market_position,
                    now,
                    Some(mark_price_before),
                )?;
            let base_asset_amount_opened = base_asset_amount_opened.unsigned_abs();

            // means position was closed and it was reduce only
            if base_asset_amount_opened == 0 {
                reduce_only = true;
            }

            base_asset_amount = base_asset_amount_closed
                .checked_add(base_asset_amount_opened)
                .ok_or_else(math_error!())?;

            quote_asset_amount_surplus = quote_asset_amount_surplus_closed
                .checked_add(quote_asset_amount_surplus_opened)
                .ok_or_else(math_error!())?;

            pnl = _pnl;
        }
    }

    Ok((
        potentially_risk_increasing,
        reduce_only,
        base_asset_amount,
        quote_asset_amount,
        quote_asset_amount_surplus,
        pnl,
    ))
}

fn calculate_quote_asset_amount_surplus(
    swap_direction: SwapDirection,
    quote_asset_swapped: u128,
    base_asset_amount: u128,
    limit_price: u128,
) -> ClearingHouseResult<(u128, u128)> {
    let quote_asset_amount = calculate_quote_asset_amount_for_maker_order(
        base_asset_amount,
        limit_price,
        swap_direction,
    )?;

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

pub fn update_unsettled_pnl(
    market_position: &mut MarketPosition,
    market: &mut Market,
    unsettled_pnl: i128,
) -> ClearingHouseResult<()> {
    let new_user_unsettled_pnl = market_position
        .unsettled_pnl
        .checked_add(unsettled_pnl)
        .ok_or_else(math_error!())?;

    // update market state
    if unsettled_pnl > 0 {
        if market_position.unsettled_pnl >= 0 {
            // increase profit
            market.unsettled_profit = market
                .unsettled_profit
                .checked_add(unsettled_pnl.unsigned_abs())
                .ok_or_else(math_error!())?;
        } else {
            // decrease loss
            market.unsettled_loss = market
                .unsettled_loss
                .checked_sub(min(
                    unsettled_pnl.unsigned_abs(),
                    market_position.unsettled_pnl.unsigned_abs(),
                ))
                .ok_or_else(math_error!())?;

            if new_user_unsettled_pnl > 0 {
                // increase profit
                market.unsettled_profit = market
                    .unsettled_profit
                    .checked_add(new_user_unsettled_pnl.unsigned_abs())
                    .ok_or_else(math_error!())?;
            }
        }
    } else if market_position.unsettled_pnl > 0 {
        // decrease profit
        market.unsettled_profit = market
            .unsettled_profit
            .checked_sub(min(
                unsettled_pnl.unsigned_abs(),
                market_position.unsettled_pnl.unsigned_abs(),
            ))
            .ok_or_else(math_error!())?;

        if new_user_unsettled_pnl < 0 {
            // increase loss
            market.unsettled_loss = market
                .unsettled_loss
                .checked_add(new_user_unsettled_pnl.unsigned_abs())
                .ok_or_else(math_error!())?;
        }
    } else {
        // increase loss
        market.unsettled_loss = market
            .unsettled_loss
            .checked_add(unsettled_pnl.unsigned_abs())
            .ok_or_else(math_error!())?;
    }

    // update user state
    market_position.unsettled_pnl = new_user_unsettled_pnl;
    Ok(())
}

#[cfg(test)]
mod test {
    use crate::controller::position::{update_position_and_market, PositionDelta};
    use crate::state::market::{Market, AMM};
    use crate::state::user::MarketPosition;

    #[test]
    fn increase_long_from_no_position() {
        let mut existing_position = MarketPosition::default();
        let position_delta = PositionDelta {
            base_asset_amount: 1,
            quote_asset_amount: 1,
        };
        let mut market = Market {
            amm: AMM {
                cumulative_funding_rate_long: 1,
                ..AMM::default()
            },
            open_interest: 0,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 1);
        assert_eq!(existing_position.quote_asset_amount, 1);
        assert_eq!(existing_position.quote_entry_amount, 1);
        assert_eq!(pnl, 0);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 1);
        assert_eq!(market.base_asset_amount_short, 0);
        assert_eq!(market.amm.net_base_asset_amount, 1);
        assert_eq!(market.amm.quote_asset_amount_long, 1);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
    }

    #[test]
    fn increase_short_from_no_position() {
        let mut existing_position = MarketPosition::default();
        let position_delta = PositionDelta {
            base_asset_amount: -1,
            quote_asset_amount: 1,
        };
        let mut market = Market {
            amm: AMM {
                cumulative_funding_rate_short: 1,
                ..AMM::default()
            },
            open_interest: 0,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, -1);
        assert_eq!(existing_position.quote_asset_amount, 1);
        assert_eq!(existing_position.quote_entry_amount, 1);
        assert_eq!(pnl, 0);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -1);
        assert_eq!(market.amm.net_base_asset_amount, -1);
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, 1);
    }

    #[test]
    fn increase_long() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 1,
            quote_asset_amount: 1,
            quote_entry_amount: 1,
            last_cumulative_funding_rate: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: 1,
            quote_asset_amount: 1,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: 1,
                quote_asset_amount_long: 1,
                ..AMM::default()
            },
            base_asset_amount_long: 1,
            base_asset_amount_short: 0,
            open_interest: 1,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 2);
        assert_eq!(existing_position.quote_asset_amount, 2);
        assert_eq!(existing_position.quote_entry_amount, 2);
        assert_eq!(pnl, 0);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 2);
        assert_eq!(market.base_asset_amount_short, 0);
        assert_eq!(market.amm.net_base_asset_amount, 2);
        assert_eq!(market.amm.quote_asset_amount_long, 2);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
    }

    #[test]
    fn increase_short() {
        let mut existing_position = MarketPosition {
            base_asset_amount: -1,
            quote_asset_amount: 1,
            quote_entry_amount: 1,
            last_cumulative_funding_rate: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: -1,
            quote_asset_amount: 1,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: -1,
                quote_asset_amount_long: 0,
                quote_asset_amount_short: 1,
                ..AMM::default()
            },
            open_interest: 1,
            base_asset_amount_short: -1,
            base_asset_amount_long: 0,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, -2);
        assert_eq!(existing_position.quote_asset_amount, 2);
        assert_eq!(existing_position.quote_entry_amount, 2);
        assert_eq!(pnl, 0);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -2);
        assert_eq!(market.amm.net_base_asset_amount, -2);
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, 2);
    }

    #[test]
    fn reduce_long_profitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 10,
            quote_asset_amount: 10,
            quote_entry_amount: 10,
            last_cumulative_funding_rate: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: -1,
            quote_asset_amount: 5,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: 10,
                quote_asset_amount_long: 10,
                quote_asset_amount_short: 0,
                ..AMM::default()
            },
            open_interest: 1,
            base_asset_amount_long: 10,
            base_asset_amount_short: 0,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 9);
        assert_eq!(existing_position.quote_asset_amount, 9);
        assert_eq!(existing_position.quote_entry_amount, 9);
        assert_eq!(pnl, 4);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 9);
        assert_eq!(market.base_asset_amount_short, 0);
        assert_eq!(market.amm.net_base_asset_amount, 9);
        assert_eq!(market.amm.quote_asset_amount_long, 9);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
    }

    #[test]
    fn reduce_long_unprofitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 10,
            quote_asset_amount: 100,
            quote_entry_amount: 100,
            last_cumulative_funding_rate: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: -1,
            quote_asset_amount: 5,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: 10,
                quote_asset_amount_long: 100,
                quote_asset_amount_short: 0,
                ..AMM::default()
            },
            open_interest: 1,
            base_asset_amount_long: 10,
            base_asset_amount_short: 0,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 9);
        assert_eq!(existing_position.quote_asset_amount, 90);
        assert_eq!(existing_position.quote_entry_amount, 90);
        assert_eq!(pnl, -5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 9);
        assert_eq!(market.base_asset_amount_short, 0);
        assert_eq!(market.amm.net_base_asset_amount, 9);
        assert_eq!(market.amm.quote_asset_amount_long, 90);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
    }

    #[test]
    fn flip_long_to_short_profitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 10,
            quote_asset_amount: 10,
            quote_entry_amount: 10,
            last_cumulative_funding_rate: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: -11,
            quote_asset_amount: 22,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: 10,
                quote_asset_amount_long: 10,
                quote_asset_amount_short: 0,
                cumulative_funding_rate_short: 2,
                ..AMM::default()
            },
            open_interest: 1,
            base_asset_amount_long: 10,
            base_asset_amount_short: 0,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, -1);
        assert_eq!(existing_position.quote_asset_amount, 2);
        assert_eq!(existing_position.quote_entry_amount, 2);
        assert_eq!(pnl, 10);
        assert_eq!(existing_position.last_cumulative_funding_rate, 2);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -1);
        assert_eq!(market.amm.net_base_asset_amount, -1);
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, 2);
    }

    #[test]
    fn flip_long_to_short_unprofitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 10,
            quote_asset_amount: 10,
            quote_entry_amount: 10,
            last_cumulative_funding_rate: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: -11,
            quote_asset_amount: 10,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: 10,
                quote_asset_amount_long: 10,
                quote_asset_amount_short: 0,
                cumulative_funding_rate_short: 2,
                ..AMM::default()
            },
            open_interest: 1,
            base_asset_amount_long: 10,
            base_asset_amount_short: 0,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, -1);
        assert_eq!(existing_position.quote_asset_amount, 1);
        assert_eq!(existing_position.quote_entry_amount, 1);
        assert_eq!(pnl, -1);
        assert_eq!(existing_position.last_cumulative_funding_rate, 2);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -1);
        assert_eq!(market.amm.net_base_asset_amount, -1);
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, 1);
    }

    #[test]
    fn reduce_short_profitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: -10,
            quote_asset_amount: 100,
            quote_entry_amount: 100,
            last_cumulative_funding_rate: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: 1,
            quote_asset_amount: 5,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: -10,
                quote_asset_amount_long: 0,
                quote_asset_amount_short: 100,
                ..AMM::default()
            },
            open_interest: 1,
            base_asset_amount_long: 0,
            base_asset_amount_short: -10,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, -9);
        assert_eq!(existing_position.quote_asset_amount, 90);
        assert_eq!(existing_position.quote_entry_amount, 90);
        assert_eq!(pnl, 5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -9);
        assert_eq!(market.amm.net_base_asset_amount, -9);
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, 90);
    }

    #[test]
    fn decrease_short_unprofitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: -10,
            quote_asset_amount: 100,
            quote_entry_amount: 100,
            last_cumulative_funding_rate: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: 1,
            quote_asset_amount: 15,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: -10,
                quote_asset_amount_long: 0,
                quote_asset_amount_short: 100,
                ..AMM::default()
            },
            open_interest: 1,
            base_asset_amount_long: 0,
            base_asset_amount_short: -10,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, -9);
        assert_eq!(existing_position.quote_asset_amount, 90);
        assert_eq!(existing_position.quote_entry_amount, 90);
        assert_eq!(pnl, -5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -9);
        assert_eq!(market.amm.net_base_asset_amount, -9);
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, 90);
    }

    #[test]
    fn flip_short_to_long_profitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: -10,
            quote_asset_amount: 100,
            quote_entry_amount: 100,
            last_cumulative_funding_rate: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: 11,
            quote_asset_amount: 60,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: -10,
                quote_asset_amount_long: 0,
                quote_asset_amount_short: 100,
                cumulative_funding_rate_long: 2,
                ..AMM::default()
            },
            open_interest: 1,
            base_asset_amount_long: 0,
            base_asset_amount_short: -10,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 1);
        assert_eq!(existing_position.quote_asset_amount, 6);
        assert_eq!(existing_position.quote_entry_amount, 6);
        assert_eq!(pnl, 46);
        assert_eq!(existing_position.last_cumulative_funding_rate, 2);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 1);
        assert_eq!(market.base_asset_amount_short, 0);
        assert_eq!(market.amm.net_base_asset_amount, 1);
        assert_eq!(market.amm.quote_asset_amount_long, 6);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
    }

    #[test]
    fn flip_short_to_long_unprofitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: -10,
            quote_asset_amount: 100,
            quote_entry_amount: 100,
            last_cumulative_funding_rate: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: 11,
            quote_asset_amount: 120,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: -10,
                quote_asset_amount_long: 0,
                quote_asset_amount_short: 100,
                cumulative_funding_rate_long: 2,
                ..AMM::default()
            },
            open_interest: 1,
            base_asset_amount_long: 0,
            base_asset_amount_short: -10,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 1);
        assert_eq!(existing_position.quote_asset_amount, 11);
        assert_eq!(existing_position.quote_entry_amount, 11);
        assert_eq!(pnl, -9);
        assert_eq!(existing_position.last_cumulative_funding_rate, 2);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 1);
        assert_eq!(market.base_asset_amount_short, 0);
        assert_eq!(market.amm.net_base_asset_amount, 1);
        assert_eq!(market.amm.quote_asset_amount_long, 11);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
    }

    #[test]
    fn close_long_profitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 10,
            quote_asset_amount: 10,
            quote_entry_amount: 10,
            last_cumulative_funding_rate: 1,
            last_funding_rate_ts: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: -10,
            quote_asset_amount: 15,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: 11,
                quote_asset_amount_long: 11,
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_long: 11,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 0);
        assert_eq!(existing_position.quote_asset_amount, 0);
        assert_eq!(existing_position.quote_entry_amount, 0);
        assert_eq!(pnl, 5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 0);
        assert_eq!(existing_position.last_funding_rate_ts, 0);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 1);
        assert_eq!(market.base_asset_amount_short, 0);
        assert_eq!(market.amm.net_base_asset_amount, 1);
        assert_eq!(market.amm.quote_asset_amount_long, 1);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
    }

    #[test]
    fn close_long_unprofitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 10,
            quote_asset_amount: 10,
            quote_entry_amount: 10,
            last_cumulative_funding_rate: 1,
            last_funding_rate_ts: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: -10,
            quote_asset_amount: 5,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: 11,
                quote_asset_amount_long: 11,
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_long: 11,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 0);
        assert_eq!(existing_position.quote_asset_amount, 0);
        assert_eq!(existing_position.quote_entry_amount, 0);
        assert_eq!(pnl, -5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 0);
        assert_eq!(existing_position.last_funding_rate_ts, 0);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 1);
        assert_eq!(market.base_asset_amount_short, 0);
        assert_eq!(market.amm.net_base_asset_amount, 1);
        assert_eq!(market.amm.quote_asset_amount_long, 1);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
    }

    #[test]
    fn close_short_profitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: -10,
            quote_asset_amount: 10,
            quote_entry_amount: 10,
            last_cumulative_funding_rate: 1,
            last_funding_rate_ts: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: 10,
            quote_asset_amount: 5,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: -11,
                quote_asset_amount_short: 11,
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_short: -11,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 0);
        assert_eq!(existing_position.quote_asset_amount, 0);
        assert_eq!(existing_position.quote_entry_amount, 0);
        assert_eq!(pnl, 5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 0);
        assert_eq!(existing_position.last_funding_rate_ts, 0);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -1);
        assert_eq!(market.amm.net_base_asset_amount, -1);
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, 1);
    }

    #[test]
    fn close_short_unprofitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: -10,
            quote_asset_amount: 10,
            quote_entry_amount: 10,
            last_cumulative_funding_rate: 1,
            last_funding_rate_ts: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: 10,
            quote_asset_amount: 15,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: -11,
                quote_asset_amount_short: 11,
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_short: -11,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 0);
        assert_eq!(existing_position.quote_asset_amount, 0);
        assert_eq!(existing_position.quote_entry_amount, 0);
        assert_eq!(pnl, -5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 0);
        assert_eq!(existing_position.last_funding_rate_ts, 0);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -1);
        assert_eq!(market.amm.net_base_asset_amount, -1);
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, 1);
    }

    #[test]
    fn close_long_with_quote_entry_amount_less_than_quote_asset_amount() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 10,
            quote_asset_amount: 10,
            quote_entry_amount: 8,
            last_cumulative_funding_rate: 1,
            last_funding_rate_ts: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: -10,
            quote_asset_amount: 5,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: 11,
                quote_asset_amount_long: 11,
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_long: 11,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 0);
        assert_eq!(existing_position.quote_asset_amount, 0);
        assert_eq!(existing_position.quote_entry_amount, 0);
        assert_eq!(pnl, -5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 0);
        assert_eq!(existing_position.last_funding_rate_ts, 0);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 1);
        assert_eq!(market.base_asset_amount_short, 0);
        assert_eq!(market.amm.net_base_asset_amount, 1);
        assert_eq!(market.amm.quote_asset_amount_long, 1);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
    }

    #[test]
    fn close_short_with_quote_entry_amount_more_than_quote_asset_amount() {
        let mut existing_position = MarketPosition {
            base_asset_amount: -10,
            quote_asset_amount: 10,
            quote_entry_amount: 15,
            last_cumulative_funding_rate: 1,
            last_funding_rate_ts: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: 10,
            quote_asset_amount: 15,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: -11,
                quote_asset_amount_short: 11,
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_short: -11,
            ..Market::default()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 0);
        assert_eq!(existing_position.quote_asset_amount, 0);
        assert_eq!(existing_position.quote_entry_amount, 0);
        assert_eq!(pnl, -5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 0);
        assert_eq!(existing_position.last_funding_rate_ts, 0);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -1);
        assert_eq!(market.amm.net_base_asset_amount, -1);
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, 1);
    }
}
