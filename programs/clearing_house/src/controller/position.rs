use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;

use crate::controller;
use crate::controller::amm::SwapDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::casting::{cast, cast_to_i128, Cast};
use crate::math::constants::{
    AMM_RESERVE_PRECISION, AMM_RESERVE_PRECISION_I128, LP_FEE_SLICE_DENOMINATOR,
    LP_FEE_SLICE_NUMERATOR, PERP_DECIMALS,
};
use crate::math::helpers::get_proportion_i128;
use crate::math::orders::{
    calculate_quote_asset_amount_for_maker_order, get_position_delta_for_fill,
    is_multiple_of_step_size,
};
use crate::math::position::{
    calculate_position_new_quote_base_pnl, get_position_update_type, PositionUpdateType,
};
use crate::math_error;
use crate::state::perp_market::PerpMarket;
use crate::state::user::{PerpPosition, PerpPositions, User};
use crate::validate;

#[cfg(test)]
#[path = "../../tests/controller/position.rs"]
mod tests;

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
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
    user_positions: &mut PerpPositions,
    market_index: u16,
) -> ClearingHouseResult<usize> {
    let new_position_index = user_positions
        .iter()
        .position(|market_position| market_position.is_available())
        .ok_or(ErrorCode::MaxNumberOfPositions)?;

    let new_market_position = PerpPosition {
        market_index,
        ..PerpPosition::default()
    };

    user_positions[new_position_index] = new_market_position;

    Ok(new_position_index)
}

pub fn get_position_index(
    user_positions: &PerpPositions,
    market_index: u16,
) -> ClearingHouseResult<usize> {
    let position_index = user_positions
        .iter()
        .position(|market_position| market_position.is_for(market_index));

    match position_index {
        Some(position_index) => Ok(position_index),
        None => Err(ErrorCode::UserHasNoPositionInMarket),
    }
}

#[derive(Default, Debug)]
pub struct PositionDelta {
    pub quote_asset_amount: i64,
    pub base_asset_amount: i64,
}

pub fn update_amm_position(
    market: &mut PerpMarket,
    delta: &PositionDelta,
) -> ClearingHouseResult<i128> {
    let update_type = get_position_update_type(&market.amm.market_position_per_lp, delta);
    let (new_quote_asset_amount, new_quote_entry_amount, new_base_asset_amount, pnl) =
        calculate_position_new_quote_base_pnl(&market.amm.market_position_per_lp, delta)?;

    // Update user position
    match update_type {
        PositionUpdateType::Close => {
            market
                .amm
                .market_position_per_lp
                .last_cumulative_funding_rate = 0;
        }
        PositionUpdateType::Open | PositionUpdateType::Flip => {
            if new_base_asset_amount > 0 {
                market
                    .amm
                    .market_position_per_lp
                    .last_cumulative_funding_rate =
                    market.amm.cumulative_funding_rate_long.cast()?;
            } else {
                market
                    .amm
                    .market_position_per_lp
                    .last_cumulative_funding_rate =
                    market.amm.cumulative_funding_rate_short.cast()?;
            }
        }
        _ => {}
    };

    market.amm.market_position_per_lp.quote_asset_amount = new_quote_asset_amount.cast()?;
    market.amm.market_position_per_lp.quote_entry_amount = new_quote_entry_amount.cast()?;
    market.amm.market_position_per_lp.base_asset_amount = new_base_asset_amount.cast()?;

    Ok(pnl)
}

pub fn update_position_and_market(
    position: &mut PerpPosition,
    market: &mut PerpMarket,
    delta: &PositionDelta,
) -> ClearingHouseResult<i64> {
    if delta.base_asset_amount == 0 {
        update_quote_asset_amount(position, market, delta.quote_asset_amount)?;
        return Ok(delta.quote_asset_amount);
    }

    let update_type = get_position_update_type(position, delta);

    // Update User
    let new_quote_asset_amount = position
        .quote_asset_amount
        .checked_add(delta.quote_asset_amount)
        .ok_or_else(math_error!())?;

    let new_base_asset_amount = position
        .base_asset_amount
        .checked_add(delta.base_asset_amount)
        .ok_or_else(math_error!())?;

    let (new_quote_entry_amount, pnl) = match update_type {
        PositionUpdateType::Open | PositionUpdateType::Increase => {
            let new_quote_entry_amount = position
                .quote_entry_amount
                .checked_add(delta.quote_asset_amount)
                .ok_or_else(math_error!())?;

            (new_quote_entry_amount, 0_i64)
        }
        PositionUpdateType::Reduce | PositionUpdateType::Close => {
            let new_quote_entry_amount = position
                .quote_entry_amount
                .checked_sub(
                    position
                        .quote_entry_amount
                        .cast::<i128>()?
                        .checked_mul(delta.base_asset_amount.abs().cast()?)
                        .ok_or_else(math_error!())?
                        .checked_div(position.base_asset_amount.abs().cast()?)
                        .ok_or_else(math_error!())?
                        .cast()?,
                )
                .ok_or_else(math_error!())?;

            let pnl = position
                .quote_entry_amount
                .checked_sub(new_quote_entry_amount)
                .ok_or_else(math_error!())?
                .checked_add(delta.quote_asset_amount)
                .ok_or_else(math_error!())?;

            (new_quote_entry_amount, pnl)
        }
        PositionUpdateType::Flip => {
            let new_quote_entry_amount = delta
                .quote_asset_amount
                .checked_sub(
                    delta
                        .quote_asset_amount
                        .cast::<i128>()?
                        .checked_mul(position.base_asset_amount.abs().cast()?)
                        .ok_or_else(math_error!())?
                        .checked_div(delta.base_asset_amount.abs().cast()?)
                        .ok_or_else(math_error!())?
                        .cast()?,
                )
                .ok_or_else(math_error!())?;

            let pnl = position
                .quote_entry_amount
                .checked_add(
                    delta
                        .quote_asset_amount
                        .checked_sub(new_quote_entry_amount)
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?;

            (new_quote_entry_amount.cast::<i64>()?, pnl)
        }
    };

    // Update Market open interest
    if let PositionUpdateType::Open = update_type {
        market.number_of_users = market
            .number_of_users
            .checked_add(1)
            .ok_or_else(math_error!())?;
    } else if let PositionUpdateType::Close = update_type {
        market.number_of_users = market
            .number_of_users
            .checked_sub(1)
            .ok_or_else(math_error!())?;
    }

    match update_type {
        PositionUpdateType::Open | PositionUpdateType::Increase => {
            if new_base_asset_amount > 0 {
                market.amm.base_asset_amount_long = market
                    .amm
                    .base_asset_amount_long
                    .checked_add(delta.base_asset_amount.cast()?)
                    .ok_or_else(math_error!())?;
                market.amm.quote_asset_amount_long = market
                    .amm
                    .quote_asset_amount_long
                    .checked_add(delta.quote_asset_amount.cast()?)
                    .ok_or_else(math_error!())?;
                market.amm.quote_entry_amount_long = market
                    .amm
                    .quote_entry_amount_long
                    .checked_add(delta.quote_asset_amount.cast()?)
                    .ok_or_else(math_error!())?;
            } else {
                market.amm.base_asset_amount_short = market
                    .amm
                    .base_asset_amount_short
                    .checked_add(delta.base_asset_amount.cast()?)
                    .ok_or_else(math_error!())?;
                market.amm.quote_asset_amount_short = market
                    .amm
                    .quote_asset_amount_short
                    .checked_add(delta.quote_asset_amount.cast()?)
                    .ok_or_else(math_error!())?;
                market.amm.quote_entry_amount_short = market
                    .amm
                    .quote_entry_amount_short
                    .checked_add(delta.quote_asset_amount.cast()?)
                    .ok_or_else(math_error!())?;
            }
        }
        PositionUpdateType::Reduce | PositionUpdateType::Close => {
            if position.base_asset_amount > 0 {
                market.amm.base_asset_amount_long = market
                    .amm
                    .base_asset_amount_long
                    .checked_add(delta.base_asset_amount.cast()?)
                    .ok_or_else(math_error!())?;
                market.amm.quote_asset_amount_long = market
                    .amm
                    .quote_asset_amount_long
                    .checked_add(delta.quote_asset_amount.cast()?)
                    .ok_or_else(math_error!())?;
                market.amm.quote_entry_amount_long = market
                    .amm
                    .quote_entry_amount_long
                    .checked_sub(
                        position
                            .quote_entry_amount
                            .checked_sub(new_quote_entry_amount)
                            .ok_or_else(math_error!())?
                            .cast()?,
                    )
                    .ok_or_else(math_error!())?;
            } else {
                market.amm.base_asset_amount_short = market
                    .amm
                    .base_asset_amount_short
                    .checked_add(delta.base_asset_amount.cast()?)
                    .ok_or_else(math_error!())?;
                market.amm.quote_asset_amount_short = market
                    .amm
                    .quote_asset_amount_short
                    .checked_add(delta.quote_asset_amount.cast()?)
                    .ok_or_else(math_error!())?;
                market.amm.quote_entry_amount_short = market
                    .amm
                    .quote_entry_amount_short
                    .checked_sub(
                        position
                            .quote_entry_amount
                            .checked_sub(new_quote_entry_amount)
                            .ok_or_else(math_error!())?
                            .cast()?,
                    )
                    .ok_or_else(math_error!())?;
            }
        }
        PositionUpdateType::Flip => {
            if new_base_asset_amount > 0 {
                market.amm.base_asset_amount_short = market
                    .amm
                    .base_asset_amount_short
                    .checked_sub(position.base_asset_amount.cast()?)
                    .ok_or_else(math_error!())?;
                market.amm.base_asset_amount_long = market
                    .amm
                    .base_asset_amount_long
                    .checked_add(new_base_asset_amount.cast()?)
                    .ok_or_else(math_error!())?;

                market.amm.quote_asset_amount_short = market
                    .amm
                    .quote_asset_amount_short
                    .checked_add(
                        delta
                            .quote_asset_amount
                            .checked_sub(new_quote_entry_amount)
                            .ok_or_else(math_error!())?
                            .cast()?,
                    )
                    .ok_or_else(math_error!())?;
                market.amm.quote_entry_amount_short = market
                    .amm
                    .quote_entry_amount_short
                    .checked_sub(position.quote_entry_amount.cast()?)
                    .ok_or_else(math_error!())?;

                market.amm.quote_asset_amount_long = market
                    .amm
                    .quote_asset_amount_long
                    .checked_add(new_quote_entry_amount.cast()?)
                    .ok_or_else(math_error!())?;
                market.amm.quote_entry_amount_long = market
                    .amm
                    .quote_entry_amount_long
                    .checked_add(new_quote_entry_amount.cast()?)
                    .ok_or_else(math_error!())?;
            } else {
                market.amm.base_asset_amount_long = market
                    .amm
                    .base_asset_amount_long
                    .checked_sub(position.base_asset_amount.cast()?)
                    .ok_or_else(math_error!())?;
                market.amm.base_asset_amount_short = market
                    .amm
                    .base_asset_amount_short
                    .checked_add(new_base_asset_amount.cast()?)
                    .ok_or_else(math_error!())?;

                market.amm.quote_asset_amount_long = market
                    .amm
                    .quote_asset_amount_long
                    .checked_add(
                        delta
                            .quote_asset_amount
                            .checked_sub(new_quote_entry_amount)
                            .ok_or_else(math_error!())?
                            .cast()?,
                    )
                    .ok_or_else(math_error!())?;
                market.amm.quote_entry_amount_long = market
                    .amm
                    .quote_entry_amount_long
                    .checked_sub(position.quote_entry_amount.cast()?)
                    .ok_or_else(math_error!())?;
                market.amm.quote_asset_amount_short = market
                    .amm
                    .quote_asset_amount_short
                    .checked_add(new_quote_entry_amount.cast()?)
                    .ok_or_else(math_error!())?;
                market.amm.quote_entry_amount_short = market
                    .amm
                    .quote_entry_amount_short
                    .checked_add(new_quote_entry_amount.cast()?)
                    .ok_or_else(math_error!())?;
            }
        }
    }

    // Validate that user funding rate is up to date before modifying
    match position.get_direction() {
        PositionDirection::Long if position.base_asset_amount != 0 => {
            validate!(
                position.last_cumulative_funding_rate == market.amm.cumulative_funding_rate_long.cast()?,
                ErrorCode::InvalidPositionLastFundingRate,
                "position.last_cumulative_funding_rate {} market.amm.cumulative_funding_rate_long {}",
                position.last_cumulative_funding_rate,
                market.amm.cumulative_funding_rate_long,
            )?;
        }
        PositionDirection::Short => {
            validate!(
                position.last_cumulative_funding_rate == market.amm.cumulative_funding_rate_short.cast()?,
                ErrorCode::InvalidPositionLastFundingRate,
                "position.last_cumulative_funding_rate {} market.amm.cumulative_funding_rate_short {}",
                position.last_cumulative_funding_rate,
                market.amm.cumulative_funding_rate_short,
            )?;
        }
        _ => {}
    }

    // Update user position
    if let PositionUpdateType::Close = update_type {
        position.last_cumulative_funding_rate = 0;
    } else if matches!(
        update_type,
        PositionUpdateType::Open | PositionUpdateType::Flip
    ) {
        if new_base_asset_amount > 0 {
            position.last_cumulative_funding_rate =
                market.amm.cumulative_funding_rate_long.cast()?;
        } else {
            position.last_cumulative_funding_rate =
                market.amm.cumulative_funding_rate_short.cast()?;
        }
    }

    validate!(
        is_multiple_of_step_size(
            position.base_asset_amount.unsigned_abs(),
            market.amm.order_step_size
        )?,
        ErrorCode::DefaultError,
        "update_position_and_market left invalid position before {} after {}",
        position.base_asset_amount,
        new_base_asset_amount
    )?;

    position.quote_asset_amount = new_quote_asset_amount;
    position.quote_entry_amount = new_quote_entry_amount;
    position.base_asset_amount = new_base_asset_amount;

    Ok(pnl)
}

pub fn update_lp_market_position(
    market: &mut PerpMarket,
    delta: &PositionDelta,
    fee_to_market: i128,
) -> ClearingHouseResult<(i128, i128, i128)> {
    let total_lp_shares = market.amm.sqrt_k;
    let user_lp_shares = market.amm.user_lp_shares;

    if user_lp_shares == 0 {
        return Ok((0, 0, 0));
    }

    // update Market per lp position
    let per_lp_delta_base = get_proportion_i128(
        delta.base_asset_amount.cast()?,
        AMM_RESERVE_PRECISION,
        total_lp_shares,
    )?;

    let per_lp_delta_quote = get_proportion_i128(
        delta.quote_asset_amount.cast()?,
        AMM_RESERVE_PRECISION,
        total_lp_shares,
    )?;

    let lp_delta_base =
        get_proportion_i128(per_lp_delta_base, user_lp_shares, AMM_RESERVE_PRECISION)?;
    let lp_delta_quote =
        get_proportion_i128(per_lp_delta_quote, user_lp_shares, AMM_RESERVE_PRECISION)?;

    let per_lp_position_delta = PositionDelta {
        base_asset_amount: -per_lp_delta_base.cast()?,
        quote_asset_amount: -per_lp_delta_quote.cast()?,
    };

    update_amm_position(market, &per_lp_position_delta)?;

    // 1/5 of fee auto goes to market
    // the rest goes to lps/market proportional
    let lp_fee = get_proportion_i128(
        fee_to_market,
        LP_FEE_SLICE_NUMERATOR,
        LP_FEE_SLICE_DENOMINATOR,
    )?
    .checked_mul(cast_to_i128(user_lp_shares)?)
    .ok_or_else(math_error!())?
    .checked_div(cast_to_i128(total_lp_shares)?)
    .ok_or_else(math_error!())?;

    let per_lp_fee = if lp_fee > 0 {
        lp_fee
            .checked_mul(AMM_RESERVE_PRECISION_I128)
            .ok_or_else(math_error!())?
            .checked_div(cast_to_i128(user_lp_shares)?)
            .ok_or_else(math_error!())?
    } else {
        0
    };

    // update per lp position
    market.amm.market_position_per_lp.quote_asset_amount = market
        .amm
        .market_position_per_lp
        .quote_asset_amount
        .checked_add(per_lp_fee.cast()?)
        .ok_or_else(math_error!())?;

    market.amm.base_asset_amount_with_amm = market
        .amm
        .base_asset_amount_with_amm
        .checked_sub(lp_delta_base)
        .ok_or_else(math_error!())?;

    market.amm.base_asset_amount_with_unsettled_lp = market
        .amm
        .base_asset_amount_with_unsettled_lp
        .checked_add(lp_delta_base)
        .ok_or_else(math_error!())?;

    Ok((lp_delta_base, lp_delta_quote, lp_fee))
}

pub fn update_position_with_base_asset_amount(
    base_asset_amount: u64,
    direction: PositionDirection,
    market: &mut PerpMarket,
    user: &mut User,
    position_index: usize,
    reserve_price_before: u128,
    now: i64,
    fill_price: Option<u128>,
) -> ClearingHouseResult<(u64, i64, i64)> {
    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Remove,
        PositionDirection::Short => SwapDirection::Add,
    };

    let (quote_asset_swapped, quote_asset_amount_surplus) = controller::amm::swap_base_asset(
        &mut market.amm,
        base_asset_amount,
        swap_direction,
        now,
        Some(reserve_price_before),
    )?;

    let (quote_asset_amount, quote_asset_amount_surplus) = match fill_price {
        Some(fill_price) => calculate_quote_asset_amount_surplus(
            direction,
            quote_asset_swapped,
            base_asset_amount,
            fill_price,
        )?,
        None => (quote_asset_swapped, quote_asset_amount_surplus),
    };

    let position_delta =
        get_position_delta_for_fill(base_asset_amount, quote_asset_amount, direction)?;

    let pnl = update_position_and_market(
        &mut user.perp_positions[position_index],
        market,
        &position_delta,
    )?;

    market.amm.base_asset_amount_with_amm = market
        .amm
        .base_asset_amount_with_amm
        .checked_add(position_delta.base_asset_amount.cast()?)
        .ok_or_else(math_error!())?;

    controller::amm::update_spread_reserves(&mut market.amm)?;

    Ok((quote_asset_amount, quote_asset_amount_surplus, pnl))
}

fn calculate_quote_asset_amount_surplus(
    position_direction: PositionDirection,
    quote_asset_swapped: u64,
    base_asset_amount: u64,
    fill_price: u128,
) -> ClearingHouseResult<(u64, i64)> {
    let quote_asset_amount = calculate_quote_asset_amount_for_maker_order(
        base_asset_amount,
        fill_price,
        PERP_DECIMALS,
        position_direction,
    )?;

    let quote_asset_amount_surplus = match position_direction {
        PositionDirection::Long => quote_asset_amount
            .cast::<i64>()?
            .checked_sub(quote_asset_swapped.cast()?)
            .ok_or_else(math_error!())?,
        PositionDirection::Short => quote_asset_swapped
            .cast::<i64>()?
            .checked_sub(quote_asset_amount.cast()?)
            .ok_or_else(math_error!())?,
    };

    Ok((quote_asset_amount, quote_asset_amount_surplus))
}

pub fn update_quote_asset_amount(
    position: &mut PerpPosition,
    market: &mut PerpMarket,
    delta: i64,
) -> ClearingHouseResult<()> {
    position.quote_asset_amount = position
        .quote_asset_amount
        .checked_add(delta)
        .ok_or_else(math_error!())?;

    match position.get_direction() {
        PositionDirection::Long => {
            market.amm.quote_asset_amount_long = market
                .amm
                .quote_asset_amount_long
                .checked_add(delta.cast()?)
                .ok_or_else(math_error!())?
        }
        PositionDirection::Short => {
            market.amm.quote_asset_amount_short = market
                .amm
                .quote_asset_amount_short
                .checked_add(delta.cast()?)
                .ok_or_else(math_error!())?
        }
    }

    Ok(())
}

pub fn update_settled_pnl(position: &mut PerpPosition, delta: i64) -> ClearingHouseResult<()> {
    position.settled_pnl = position
        .settled_pnl
        .checked_add(delta)
        .ok_or_else(math_error!())?;

    Ok(())
}

pub fn increase_open_bids_and_asks(
    position: &mut PerpPosition,
    direction: &PositionDirection,
    base_asset_amount_unfilled: u64,
) -> ClearingHouseResult {
    match direction {
        PositionDirection::Long => {
            position.open_bids = position
                .open_bids
                .checked_add(cast(base_asset_amount_unfilled)?)
                .ok_or_else(math_error!())?;
        }
        PositionDirection::Short => {
            position.open_asks = position
                .open_asks
                .checked_sub(cast(base_asset_amount_unfilled)?)
                .ok_or_else(math_error!())?;
        }
    }

    Ok(())
}

pub fn decrease_open_bids_and_asks(
    position: &mut PerpPosition,
    direction: &PositionDirection,
    base_asset_amount_unfilled: u64,
) -> ClearingHouseResult {
    match direction {
        PositionDirection::Long => {
            position.open_bids = position
                .open_bids
                .checked_sub(cast(base_asset_amount_unfilled)?)
                .ok_or_else(math_error!())?;
        }
        PositionDirection::Short => {
            position.open_asks = position
                .open_asks
                .checked_add(cast(base_asset_amount_unfilled)?)
                .ok_or_else(math_error!())?;
        }
    }

    Ok(())
}
