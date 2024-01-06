use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;

use crate::controller;
use crate::controller::amm::SwapDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::{MAX_BASE_ASSET_AMOUNT_WITH_AMM, PERP_DECIMALS};
// use crate::math::helpers::get_proportion_i128;
use crate::math::orders::{
    calculate_quote_asset_amount_for_maker_order, get_position_delta_for_fill,
    is_multiple_of_step_size,
};
use crate::math::position::{get_position_update_type, PositionUpdateType};
use crate::math::safe_math::SafeMath;
use crate::math_error;
use crate::safe_increment;
use crate::state::perp_market::{AMMLiquiditySplit, PerpMarket};
use crate::state::user::{PerpPosition, PerpPositions, User};
use crate::validate;

#[cfg(test)]
mod tests;

#[cfg_attr(feature = "sdk", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "sdk", serde(rename_all = "lowercase"))]
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

impl PositionDirection {
    pub fn opposite(&self) -> Self {
        match self {
            PositionDirection::Long => PositionDirection::Short,
            PositionDirection::Short => PositionDirection::Long,
        }
    }
}

pub fn add_new_position(
    user_positions: &mut PerpPositions,
    market_index: u16,
) -> DriftResult<usize> {
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

pub fn get_position_index(user_positions: &PerpPositions, market_index: u16) -> DriftResult<usize> {
    let position_index = user_positions
        .iter()
        .position(|market_position| market_position.is_for(market_index));

    match position_index {
        Some(position_index) => Ok(position_index),
        None => Err(ErrorCode::UserHasNoPositionInMarket),
    }
}

#[derive(Default, PartialEq, Debug)]
pub struct PositionDelta {
    pub quote_asset_amount: i64,
    pub base_asset_amount: i64,
}

pub fn update_position_and_market(
    position: &mut PerpPosition,
    market: &mut PerpMarket,
    delta: &PositionDelta,
) -> DriftResult<i64> {
    if delta.base_asset_amount == 0 {
        update_quote_asset_amount(position, market, delta.quote_asset_amount)?;
        return Ok(delta.quote_asset_amount);
    }

    let update_type = get_position_update_type(position, delta);

    // Update User
    let new_quote_asset_amount = position
        .quote_asset_amount
        .safe_add(delta.quote_asset_amount)?;

    let new_base_asset_amount = position
        .base_asset_amount
        .safe_add(delta.base_asset_amount)?;

    let (new_quote_entry_amount, new_quote_break_even_amount, pnl) = match update_type {
        PositionUpdateType::Open | PositionUpdateType::Increase => {
            let new_quote_entry_amount = position
                .quote_entry_amount
                .safe_add(delta.quote_asset_amount)?;

            let new_quote_break_even_amount = position
                .quote_break_even_amount
                .safe_add(delta.quote_asset_amount)?;

            (new_quote_entry_amount, new_quote_break_even_amount, 0_i64)
        }
        PositionUpdateType::Reduce | PositionUpdateType::Close => {
            let new_quote_entry_amount = position.quote_entry_amount.safe_sub(
                position
                    .quote_entry_amount
                    .cast::<i128>()?
                    .safe_mul(delta.base_asset_amount.abs().cast()?)?
                    .safe_div(position.base_asset_amount.abs().cast()?)?
                    .cast()?,
            )?;

            let new_quote_break_even_amount = position.quote_break_even_amount.safe_sub(
                position
                    .quote_break_even_amount
                    .cast::<i128>()?
                    .safe_mul(delta.base_asset_amount.abs().cast()?)?
                    .safe_div(position.base_asset_amount.abs().cast()?)?
                    .cast()?,
            )?;

            let pnl = position
                .quote_entry_amount
                .safe_sub(new_quote_entry_amount)?
                .safe_add(delta.quote_asset_amount)?;

            (new_quote_entry_amount, new_quote_break_even_amount, pnl)
        }
        PositionUpdateType::Flip => {
            // same calculation for new_quote_entry_amount
            let new_quote_break_even_amount = delta.quote_asset_amount.safe_sub(
                delta
                    .quote_asset_amount
                    .cast::<i128>()?
                    .safe_mul(position.base_asset_amount.abs().cast()?)?
                    .safe_div(delta.base_asset_amount.abs().cast()?)?
                    .cast()?,
            )?;

            let pnl = position.quote_entry_amount.safe_add(
                delta
                    .quote_asset_amount
                    .safe_sub(new_quote_break_even_amount)?,
            )?;

            (
                new_quote_break_even_amount,
                new_quote_break_even_amount,
                pnl,
            )
        }
    };

    // Update Market open interest
    if let PositionUpdateType::Open = update_type {
        if position.quote_asset_amount == 0 && position.base_asset_amount == 0 {
            market.number_of_users = market.number_of_users.safe_add(1)?;
        }

        market.number_of_users_with_base = market.number_of_users_with_base.safe_add(1)?;
    } else if let PositionUpdateType::Close = update_type {
        if new_base_asset_amount == 0 && new_quote_asset_amount == 0 {
            market.number_of_users = market.number_of_users.safe_sub(1)?;
        }

        market.number_of_users_with_base = market.number_of_users_with_base.safe_sub(1)?;
    }

    market.amm.quote_asset_amount = market
        .amm
        .quote_asset_amount
        .safe_add(delta.quote_asset_amount.cast()?)?;

    match update_type {
        PositionUpdateType::Open | PositionUpdateType::Increase => {
            if new_base_asset_amount > 0 {
                market.amm.base_asset_amount_long = market
                    .amm
                    .base_asset_amount_long
                    .safe_add(delta.base_asset_amount.cast()?)?;
                market.amm.quote_entry_amount_long = market
                    .amm
                    .quote_entry_amount_long
                    .safe_add(delta.quote_asset_amount.cast()?)?;
                market.amm.quote_break_even_amount_long =
                    market
                        .amm
                        .quote_break_even_amount_long
                        .safe_add(delta.quote_asset_amount.cast()?)?;
            } else {
                market.amm.base_asset_amount_short = market
                    .amm
                    .base_asset_amount_short
                    .safe_add(delta.base_asset_amount.cast()?)?;
                market.amm.quote_entry_amount_short = market
                    .amm
                    .quote_entry_amount_short
                    .safe_add(delta.quote_asset_amount.cast()?)?;
                market.amm.quote_break_even_amount_short = market
                    .amm
                    .quote_break_even_amount_short
                    .safe_add(delta.quote_asset_amount.cast()?)?;
            }
        }
        PositionUpdateType::Reduce | PositionUpdateType::Close => {
            if position.base_asset_amount > 0 {
                market.amm.base_asset_amount_long = market
                    .amm
                    .base_asset_amount_long
                    .safe_add(delta.base_asset_amount.cast()?)?;
                market.amm.quote_entry_amount_long = market.amm.quote_entry_amount_long.safe_sub(
                    position
                        .quote_entry_amount
                        .safe_sub(new_quote_entry_amount)?
                        .cast()?,
                )?;
                market.amm.quote_break_even_amount_long =
                    market.amm.quote_break_even_amount_long.safe_sub(
                        position
                            .quote_break_even_amount
                            .safe_sub(new_quote_break_even_amount)?
                            .cast()?,
                    )?;
            } else {
                market.amm.base_asset_amount_short = market
                    .amm
                    .base_asset_amount_short
                    .safe_add(delta.base_asset_amount.cast()?)?;
                market.amm.quote_entry_amount_short =
                    market.amm.quote_entry_amount_short.safe_sub(
                        position
                            .quote_entry_amount
                            .safe_sub(new_quote_entry_amount)?
                            .cast()?,
                    )?;
                market.amm.quote_break_even_amount_short =
                    market.amm.quote_break_even_amount_short.safe_sub(
                        position
                            .quote_break_even_amount
                            .safe_sub(new_quote_break_even_amount)?
                            .cast()?,
                    )?;
            }
        }
        PositionUpdateType::Flip => {
            if new_base_asset_amount > 0 {
                market.amm.base_asset_amount_short = market
                    .amm
                    .base_asset_amount_short
                    .safe_sub(position.base_asset_amount.cast()?)?;
                market.amm.base_asset_amount_long = market
                    .amm
                    .base_asset_amount_long
                    .safe_add(new_base_asset_amount.cast()?)?;

                market.amm.quote_entry_amount_short = market
                    .amm
                    .quote_entry_amount_short
                    .safe_sub(position.quote_entry_amount.cast()?)?;
                market.amm.quote_entry_amount_long = market
                    .amm
                    .quote_entry_amount_long
                    .safe_add(new_quote_entry_amount.cast()?)?;

                market.amm.quote_break_even_amount_short = market
                    .amm
                    .quote_break_even_amount_short
                    .safe_sub(position.quote_break_even_amount.cast()?)?;
                market.amm.quote_break_even_amount_long =
                    market
                        .amm
                        .quote_break_even_amount_long
                        .safe_add(new_quote_break_even_amount.cast()?)?;
            } else {
                market.amm.base_asset_amount_long = market
                    .amm
                    .base_asset_amount_long
                    .safe_sub(position.base_asset_amount.cast()?)?;
                market.amm.base_asset_amount_short = market
                    .amm
                    .base_asset_amount_short
                    .safe_add(new_base_asset_amount.cast()?)?;

                market.amm.quote_entry_amount_long = market
                    .amm
                    .quote_entry_amount_long
                    .safe_sub(position.quote_entry_amount.cast()?)?;
                market.amm.quote_entry_amount_short = market
                    .amm
                    .quote_entry_amount_short
                    .safe_add(new_quote_entry_amount.cast()?)?;

                market.amm.quote_break_even_amount_long =
                    market
                        .amm
                        .quote_break_even_amount_long
                        .safe_sub(position.quote_break_even_amount.cast()?)?;
                market.amm.quote_break_even_amount_short = market
                    .amm
                    .quote_break_even_amount_short
                    .safe_add(new_quote_break_even_amount.cast()?)?;
            }
        }
    }

    // Validate that user funding rate is up to date before modifying
    match position.get_direction() {
        PositionDirection::Long if position.base_asset_amount != 0 => {
            validate!(
                position.last_cumulative_funding_rate.cast::<i128>()? == market.amm.cumulative_funding_rate_long,
                ErrorCode::InvalidPositionLastFundingRate,
                "position.last_cumulative_funding_rate {} market.amm.cumulative_funding_rate_long {}",
                position.last_cumulative_funding_rate.cast::<i128>()?,
                market.amm.cumulative_funding_rate_long,
            )?;
        }
        PositionDirection::Short => {
            validate!(
                position.last_cumulative_funding_rate == market.amm.cumulative_funding_rate_short.cast::<i64>()?,
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
        ErrorCode::InvalidPerpPositionDetected,
        "update_position_and_market left invalid position before {} after {}",
        position.base_asset_amount,
        new_base_asset_amount
    )?;

    position.quote_asset_amount = new_quote_asset_amount;
    position.quote_entry_amount = new_quote_entry_amount;
    position.quote_break_even_amount = new_quote_break_even_amount;
    position.base_asset_amount = new_base_asset_amount;

    Ok(pnl)
}

pub fn update_lp_market_position(
    market: &mut PerpMarket,
    delta: &PositionDelta,
    fee_to_market: i128,
    liquidity_split: AMMLiquiditySplit,
) -> DriftResult<i128> {
    if market.amm.user_lp_shares == 0 || liquidity_split == AMMLiquiditySplit::ProtocolOwned {
        return Ok(0); // no need to split with LP
    }

    let base_unit: i128 = market.amm.get_per_lp_base_unit()?;

    let (per_lp_delta_base, per_lp_delta_quote, per_lp_fee) =
        market
            .amm
            .calculate_per_lp_delta(delta, fee_to_market, liquidity_split, base_unit)?;

    let lp_delta_base = market
        .amm
        .calculate_lp_base_delta(per_lp_delta_base, base_unit)?;

    market.amm.base_asset_amount_per_lp = market
        .amm
        .base_asset_amount_per_lp
        .safe_add(-per_lp_delta_base)?;

    market.amm.quote_asset_amount_per_lp = market
        .amm
        .quote_asset_amount_per_lp
        .safe_add(-per_lp_delta_quote)?;

    // track total fee earned by lps (to attribute breakdown of IL)
    market.amm.total_fee_earned_per_lp = market
        .amm
        .total_fee_earned_per_lp
        .saturating_add(per_lp_fee.cast()?);

    // update per lp position
    market.amm.quote_asset_amount_per_lp =
        market.amm.quote_asset_amount_per_lp.safe_add(per_lp_fee)?;

    market.amm.base_asset_amount_with_amm = market
        .amm
        .base_asset_amount_with_amm
        .safe_sub(lp_delta_base)?;

    market.amm.base_asset_amount_with_unsettled_lp = market
        .amm
        .base_asset_amount_with_unsettled_lp
        .safe_add(lp_delta_base)?;

    Ok(lp_delta_base)
}

pub fn update_position_with_base_asset_amount(
    base_asset_amount: u64,
    direction: PositionDirection,
    market: &mut PerpMarket,
    user: &mut User,
    position_index: usize,
    fill_price: Option<u64>,
) -> DriftResult<(u64, i64, i64)> {
    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Remove,
        PositionDirection::Short => SwapDirection::Add,
    };

    let (quote_asset_swapped, quote_asset_amount_surplus) =
        controller::amm::swap_base_asset(market, base_asset_amount, swap_direction)?;

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
        .safe_add(position_delta.base_asset_amount.cast()?)?;

    validate!(
        market.amm.base_asset_amount_with_amm.unsigned_abs() <= MAX_BASE_ASSET_AMOUNT_WITH_AMM,
        ErrorCode::InvalidAmmDetected,
        "market.amm.base_asset_amount_with_amm={} cannot exceed MAX_BASE_ASSET_AMOUNT_WITH_AMM",
        market.amm.base_asset_amount_with_amm
    )?;

    controller::amm::update_spread_reserves(&mut market.amm)?;

    Ok((quote_asset_amount, quote_asset_amount_surplus, pnl))
}

fn calculate_quote_asset_amount_surplus(
    position_direction: PositionDirection,
    quote_asset_swapped: u64,
    base_asset_amount: u64,
    fill_price: u64,
) -> DriftResult<(u64, i64)> {
    let quote_asset_amount = calculate_quote_asset_amount_for_maker_order(
        base_asset_amount,
        fill_price,
        PERP_DECIMALS,
        position_direction,
    )?;

    let quote_asset_amount_surplus = match position_direction {
        PositionDirection::Long => quote_asset_amount
            .cast::<i64>()?
            .safe_sub(quote_asset_swapped.cast()?)?,
        PositionDirection::Short => quote_asset_swapped
            .cast::<i64>()?
            .safe_sub(quote_asset_amount.cast()?)?,
    };

    Ok((quote_asset_amount, quote_asset_amount_surplus))
}

pub fn update_quote_asset_and_break_even_amount(
    position: &mut PerpPosition,
    market: &mut PerpMarket,
    delta: i64,
) -> DriftResult {
    update_quote_asset_amount(position, market, delta)?;
    update_quote_break_even_amount(position, market, delta)
}

pub fn update_quote_asset_amount(
    position: &mut PerpPosition,
    market: &mut PerpMarket,
    delta: i64,
) -> DriftResult<()> {
    if delta == 0 {
        return Ok(());
    }

    if position.quote_asset_amount == 0 && position.base_asset_amount == 0 {
        market.number_of_users = market.number_of_users.safe_add(1)?;
    }

    position.quote_asset_amount = position.quote_asset_amount.safe_add(delta)?;

    market.amm.quote_asset_amount = market.amm.quote_asset_amount.safe_add(delta.cast()?)?;

    if position.quote_asset_amount == 0 && position.base_asset_amount == 0 {
        market.number_of_users = market.number_of_users.safe_sub(1)?;
    }

    Ok(())
}

pub fn update_quote_break_even_amount(
    position: &mut PerpPosition,
    market: &mut PerpMarket,
    delta: i64,
) -> DriftResult<()> {
    if delta == 0 || position.base_asset_amount == 0 {
        return Ok(());
    }

    position.quote_break_even_amount = position.quote_break_even_amount.safe_add(delta)?;
    match position.get_direction() {
        PositionDirection::Long => {
            market.amm.quote_break_even_amount_long = market
                .amm
                .quote_break_even_amount_long
                .safe_add(delta.cast()?)?
        }
        PositionDirection::Short => {
            market.amm.quote_break_even_amount_short = market
                .amm
                .quote_break_even_amount_short
                .safe_add(delta.cast()?)?
        }
    }

    Ok(())
}

pub fn update_settled_pnl(user: &mut User, position_index: usize, delta: i64) -> DriftResult<()> {
    update_user_settled_pnl(user, delta)?;
    update_position_settled_pnl(&mut user.perp_positions[position_index], delta)?;
    Ok(())
}

pub fn update_position_settled_pnl(position: &mut PerpPosition, delta: i64) -> DriftResult<()> {
    position.settled_pnl = position.settled_pnl.safe_add(delta)?;

    Ok(())
}

pub fn update_user_settled_pnl(user: &mut User, delta: i64) -> DriftResult<()> {
    safe_increment!(user.settled_perp_pnl, delta);
    Ok(())
}

pub fn increase_open_bids_and_asks(
    position: &mut PerpPosition,
    direction: &PositionDirection,
    base_asset_amount_unfilled: u64,
) -> DriftResult {
    match direction {
        PositionDirection::Long => {
            position.open_bids = position
                .open_bids
                .safe_add(base_asset_amount_unfilled.cast()?)?;
        }
        PositionDirection::Short => {
            position.open_asks = position
                .open_asks
                .safe_sub(base_asset_amount_unfilled.cast()?)?;
        }
    }

    Ok(())
}

pub fn decrease_open_bids_and_asks(
    position: &mut PerpPosition,
    direction: &PositionDirection,
    base_asset_amount_unfilled: u64,
) -> DriftResult {
    match direction {
        PositionDirection::Long => {
            position.open_bids = position
                .open_bids
                .safe_sub(base_asset_amount_unfilled.cast()?)?;
        }
        PositionDirection::Short => {
            position.open_asks = position
                .open_asks
                .safe_add(base_asset_amount_unfilled.cast()?)?;
        }
    }

    Ok(())
}
