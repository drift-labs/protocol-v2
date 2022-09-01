use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;

use crate::controller;
use crate::controller::amm::SwapDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::casting::{cast, cast_to_i128};
use crate::math::constants::{AMM_RESERVE_PRECISION, AMM_RESERVE_PRECISION_I128};
use crate::math::helpers::get_proportion_i128;
use crate::math::orders::{
    calculate_quote_asset_amount_for_maker_order, get_position_delta_for_fill,
    is_multiple_of_step_size,
};
use crate::math::position::{
    calculate_position_new_quote_base_pnl, get_position_update_type, PositionUpdateType,
};
use crate::math_error;
use crate::state::market::Market;
use crate::state::user::{User, UserPositions};
use crate::validate;
use crate::MarketPosition;

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
    user_positions: &mut UserPositions,
    market_index: u64,
) -> ClearingHouseResult<usize> {
    let new_position_index = user_positions
        .iter()
        .position(|market_position| market_position.is_available())
        .ok_or(ErrorCode::MaxNumberOfPositions)?;

    let new_market_position = MarketPosition {
        market_index,
        ..MarketPosition::default()
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

#[derive(Debug)]
pub struct PositionDelta {
    pub quote_asset_amount: i128,
    pub base_asset_amount: i128,
}

pub fn update_amm_position(
    market: &mut Market,
    delta: &PositionDelta,
    is_per_lp_position: bool,
) -> ClearingHouseResult<i128> {
    let mut position = if is_per_lp_position {
        market.amm.market_position_per_lp
    } else {
        market.amm.market_position
    };

    let update_type = get_position_update_type(&position, delta);
    let (new_quote_asset_amount, new_quote_entry_amount, new_base_asset_amount, pnl) =
        calculate_position_new_quote_base_pnl(&position, delta)?;

    // Update user position
    match update_type {
        PositionUpdateType::Close => {
            position.last_cumulative_funding_rate = 0;
            position.last_funding_rate_ts = 0;
        }
        PositionUpdateType::Open | PositionUpdateType::Flip => {
            if new_base_asset_amount > 0 {
                position.last_cumulative_funding_rate = market.amm.cumulative_funding_rate_long;
            } else {
                position.last_cumulative_funding_rate = market.amm.cumulative_funding_rate_short;
            }
        }
        _ => {}
    };

    position.quote_asset_amount = new_quote_asset_amount;
    position.quote_entry_amount = new_quote_entry_amount;
    position.base_asset_amount = new_base_asset_amount;

    if is_per_lp_position {
        market.amm.market_position_per_lp = position;
    } else {
        market.amm.market_position = position;
    }

    Ok(pnl)
}

pub fn update_position_and_market(
    position: &mut MarketPosition,
    market: &mut Market,
    delta: &PositionDelta,
) -> ClearingHouseResult<i128> {
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

            (new_quote_entry_amount, 0_i128)
        }
        PositionUpdateType::Reduce | PositionUpdateType::Close => {
            let new_quote_entry_amount = position
                .quote_entry_amount
                .checked_sub(
                    position
                        .quote_entry_amount
                        .checked_mul(delta.base_asset_amount.abs())
                        .ok_or_else(math_error!())?
                        .checked_div(position.base_asset_amount.abs())
                        .ok_or_else(math_error!())?,
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
                        .checked_mul(position.base_asset_amount.abs())
                        .ok_or_else(math_error!())?
                        .checked_div(delta.base_asset_amount.abs())
                        .ok_or_else(math_error!())?,
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

            (new_quote_entry_amount, pnl)
        }
    };

    // Update Market open interest
    if let PositionUpdateType::Open = update_type {
        market.open_interest = market
            .open_interest
            .checked_add(1)
            .ok_or_else(math_error!())?;
    } else if let PositionUpdateType::Close = update_type {
        market.open_interest = market
            .open_interest
            .checked_sub(1)
            .ok_or_else(math_error!())?;
    }

    match update_type {
        PositionUpdateType::Open | PositionUpdateType::Increase => {
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
                market.amm.quote_entry_amount_long = market
                    .amm
                    .quote_entry_amount_long
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
                market.amm.quote_entry_amount_short = market
                    .amm
                    .quote_entry_amount_short
                    .checked_add(delta.quote_asset_amount)
                    .ok_or_else(math_error!())?;
            }
        }
        PositionUpdateType::Reduce | PositionUpdateType::Close => {
            if position.base_asset_amount > 0 {
                market.base_asset_amount_long = market
                    .base_asset_amount_long
                    .checked_add(delta.base_asset_amount)
                    .ok_or_else(math_error!())?;
                market.amm.quote_asset_amount_long = market
                    .amm
                    .quote_asset_amount_long
                    .checked_add(delta.quote_asset_amount)
                    .ok_or_else(math_error!())?;
                market.amm.quote_entry_amount_long = market
                    .amm
                    .quote_entry_amount_long
                    .checked_sub(
                        position
                            .quote_entry_amount
                            .checked_sub(new_quote_entry_amount)
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
                    .checked_add(delta.quote_asset_amount)
                    .ok_or_else(math_error!())?;
                market.amm.quote_entry_amount_short = market
                    .amm
                    .quote_entry_amount_short
                    .checked_sub(
                        position
                            .quote_entry_amount
                            .checked_sub(new_quote_entry_amount)
                            .ok_or_else(math_error!())?,
                    )
                    .ok_or_else(math_error!())?;
            }
        }
        PositionUpdateType::Flip => {
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
                    .checked_add(
                        delta
                            .quote_asset_amount
                            .checked_sub(new_quote_entry_amount)
                            .ok_or_else(math_error!())?,
                    )
                    .ok_or_else(math_error!())?;
                market.amm.quote_entry_amount_short = market
                    .amm
                    .quote_entry_amount_short
                    .checked_sub(position.quote_entry_amount)
                    .ok_or_else(math_error!())?;

                market.amm.quote_asset_amount_long = market
                    .amm
                    .quote_asset_amount_long
                    .checked_add(new_quote_entry_amount)
                    .ok_or_else(math_error!())?;
                market.amm.quote_entry_amount_long = market
                    .amm
                    .quote_entry_amount_long
                    .checked_add(new_quote_entry_amount)
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
                    .checked_add(
                        delta
                            .quote_asset_amount
                            .checked_sub(new_quote_entry_amount)
                            .ok_or_else(math_error!())?,
                    )
                    .ok_or_else(math_error!())?;
                market.amm.quote_entry_amount_long = market
                    .amm
                    .quote_entry_amount_long
                    .checked_sub(position.quote_entry_amount)
                    .ok_or_else(math_error!())?;
                market.amm.quote_asset_amount_short = market
                    .amm
                    .quote_asset_amount_short
                    .checked_add(new_quote_entry_amount)
                    .ok_or_else(math_error!())?;
                market.amm.quote_entry_amount_short = market
                    .amm
                    .quote_entry_amount_short
                    .checked_add(new_quote_entry_amount)
                    .ok_or_else(math_error!())?;
            }
        }
    }

    // Validate that user funding rate is up to date before modifying
    match position.get_direction() {
        PositionDirection::Long if position.base_asset_amount != 0 => {
            validate!(
                position.last_cumulative_funding_rate == market.amm.cumulative_funding_rate_long,
                ErrorCode::InvalidPositionLastFundingRate,
                "position.last_cumulative_funding_rate {} market.amm.cumulative_funding_rate_long {}",
                position.last_cumulative_funding_rate,
                market.amm.cumulative_funding_rate_long,
            )?;
        }
        PositionDirection::Short => {
            validate!(
                position.last_cumulative_funding_rate == market.amm.cumulative_funding_rate_short,
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
        position.last_funding_rate_ts = 0;
    } else if matches!(
        update_type,
        PositionUpdateType::Open | PositionUpdateType::Flip
    ) {
        if new_base_asset_amount > 0 {
            position.last_cumulative_funding_rate = market.amm.cumulative_funding_rate_long;
        } else {
            position.last_cumulative_funding_rate = market.amm.cumulative_funding_rate_short;
        }
    }

    validate!(
        is_multiple_of_step_size(
            position.base_asset_amount.unsigned_abs(),
            market.amm.base_asset_amount_step_size
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

pub fn update_amm_and_lp_market_position(
    market: &mut Market,
    delta: &PositionDelta,
    fee_to_market: i128,
) -> ClearingHouseResult {
    let total_lp_shares = market.amm.sqrt_k;
    let non_amm_lp_shares = market.amm.user_lp_shares;

    let (lp_delta_base, lp_delta_quote, lp_fee) = if non_amm_lp_shares > 0 {
        // update Market per lp position
        let lp_delta_base =
            get_proportion_i128(delta.base_asset_amount, non_amm_lp_shares, total_lp_shares)?;
        let lp_delta_quote =
            get_proportion_i128(delta.quote_asset_amount, non_amm_lp_shares, total_lp_shares)?;

        let per_lp_delta_base = -get_proportion_i128(
            delta.base_asset_amount,
            AMM_RESERVE_PRECISION,
            total_lp_shares,
        )?;
        let per_lp_delta_quote = -get_proportion_i128(
            delta.quote_asset_amount,
            AMM_RESERVE_PRECISION,
            total_lp_shares,
        )?;
        let per_lp_position_delta = PositionDelta {
            base_asset_amount: per_lp_delta_base,
            quote_asset_amount: per_lp_delta_quote,
        };

        update_amm_position(market, &per_lp_position_delta, true)?;

        // 1/5 of fee auto goes to market
        // the rest goes to lps/market proportional
        let lp_fee = (fee_to_market - (fee_to_market / 5)) // todo: 80% retained
            .checked_mul(cast_to_i128(non_amm_lp_shares)?)
            .ok_or_else(math_error!())?
            .checked_div(cast_to_i128(total_lp_shares)?)
            .ok_or_else(math_error!())?;

        let per_lp_fee = if lp_fee > 0 {
            lp_fee
                .checked_mul(AMM_RESERVE_PRECISION_I128)
                .ok_or_else(math_error!())?
                .checked_div(cast_to_i128(market.amm.user_lp_shares)?)
                .ok_or_else(math_error!())?
        } else {
            0
        };

        // update per lp position
        update_quote_asset_amount(&mut market.amm.market_position_per_lp, per_lp_fee)?;

        (lp_delta_base, lp_delta_quote, lp_fee)
    } else {
        (0, 0, 0)
    };

    let amm_fee = fee_to_market
        .checked_sub(lp_fee)
        .ok_or_else(math_error!())?;

    // Update AMM position
    let amm_baa = delta
        .base_asset_amount
        .checked_sub(lp_delta_base)
        .ok_or_else(math_error!())?;

    let amm_qaa = delta
        .quote_asset_amount
        .checked_sub(lp_delta_quote)
        .ok_or_else(math_error!())?;

    update_amm_position(
        market,
        &PositionDelta {
            base_asset_amount: -amm_baa,
            quote_asset_amount: -amm_qaa,
        },
        false,
    )?;

    update_quote_asset_amount(&mut market.amm.market_position, amm_fee)?;

    market.amm.net_base_asset_amount = market
        .amm
        .net_base_asset_amount
        .checked_sub(lp_delta_base)
        .ok_or_else(math_error!())?;

    market.amm.net_unsettled_lp_base_asset_amount = market
        .amm
        .net_unsettled_lp_base_asset_amount
        .checked_add(lp_delta_base)
        .ok_or_else(math_error!())?;

    Ok(())
}

pub fn update_position_with_base_asset_amount(
    base_asset_amount: u128,
    direction: PositionDirection,
    market: &mut Market,
    user: &mut User,
    position_index: usize,
    mark_price_before: u128,
    now: i64,
    fill_price: Option<u128>,
) -> ClearingHouseResult<(u128, i128, i128)> {
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
    )?;

    let (quote_asset_amount, quote_asset_amount_surplus) = match fill_price {
        Some(fill_price) => calculate_quote_asset_amount_surplus(
            swap_direction,
            quote_asset_swapped,
            base_asset_amount,
            fill_price,
        )?,
        None => (quote_asset_swapped, quote_asset_amount_surplus),
    };

    let position_delta =
        get_position_delta_for_fill(base_asset_amount, quote_asset_amount, direction)?;

    let pnl =
        update_position_and_market(&mut user.positions[position_index], market, &position_delta)?;

    market.amm.net_base_asset_amount = market
        .amm
        .net_base_asset_amount
        .checked_add(position_delta.base_asset_amount)
        .ok_or_else(math_error!())?;

    Ok((quote_asset_amount, quote_asset_amount_surplus, pnl))
}

fn calculate_quote_asset_amount_surplus(
    swap_direction: SwapDirection,
    quote_asset_swapped: u128,
    base_asset_amount: u128,
    fill_price: u128,
) -> ClearingHouseResult<(u128, i128)> {
    let quote_asset_amount = calculate_quote_asset_amount_for_maker_order(
        base_asset_amount,
        fill_price,
        swap_direction,
    )?;

    let quote_asset_amount_surplus = match swap_direction {
        SwapDirection::Remove => cast_to_i128(quote_asset_amount)?
            .checked_sub(cast_to_i128(quote_asset_swapped)?)
            .ok_or_else(math_error!())?,
        SwapDirection::Add => cast_to_i128(quote_asset_swapped)?
            .checked_sub(cast_to_i128(quote_asset_amount)?)
            .ok_or_else(math_error!())?,
    };

    Ok((quote_asset_amount, quote_asset_amount_surplus))
}

pub fn update_quote_asset_amount(
    position: &mut MarketPosition,
    delta: i128,
) -> ClearingHouseResult<()> {
    position.quote_asset_amount = position
        .quote_asset_amount
        .checked_add(delta)
        .ok_or_else(math_error!())?;

    Ok(())
}

pub fn update_realized_pnl(position: &mut MarketPosition, delta: i64) -> ClearingHouseResult<()> {
    position.realized_pnl = position
        .realized_pnl
        .checked_add(delta)
        .ok_or_else(math_error!())?;

    Ok(())
}

pub fn increase_open_bids_and_asks(
    position: &mut MarketPosition,
    direction: &PositionDirection,
    base_asset_amount_unfilled: u128,
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
    position: &mut MarketPosition,
    direction: &PositionDirection,
    base_asset_amount_unfilled: u128,
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

#[cfg(test)]
mod test {
    use crate::controller::position::{
        update_amm_and_lp_market_position, update_position_and_market, PositionDelta,
    };
    use crate::math::constants::{AMM_RESERVE_PRECISION, AMM_RESERVE_PRECISION_I128};
    use crate::state::market::{Market, AMM};
    use crate::state::user::MarketPosition;

    #[test]
    fn full_amm_split() {
        let delta = PositionDelta {
            base_asset_amount: 10 * AMM_RESERVE_PRECISION_I128,
            quote_asset_amount: -10 * AMM_RESERVE_PRECISION_I128,
        };

        let amm = AMM {
            user_lp_shares: 0,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            net_base_asset_amount: 10 * AMM_RESERVE_PRECISION_I128,
            ..AMM::default_test()
        };
        let mut market = Market {
            amm,
            ..Market::default_test()
        };

        update_amm_and_lp_market_position(&mut market, &delta, 0).unwrap();

        assert_eq!(
            market.amm.market_position.base_asset_amount,
            -10 * AMM_RESERVE_PRECISION_I128
        );
        assert_eq!(
            market.amm.market_position.quote_asset_amount,
            10 * AMM_RESERVE_PRECISION_I128
        );
        assert_eq!(market.amm.net_unsettled_lp_base_asset_amount, 0);
        assert_eq!(
            market.amm.net_base_asset_amount,
            10 * AMM_RESERVE_PRECISION_I128
        );
    }

    #[test]
    fn full_lp_split() {
        let delta = PositionDelta {
            base_asset_amount: 10 * AMM_RESERVE_PRECISION_I128,
            quote_asset_amount: -10 * AMM_RESERVE_PRECISION_I128,
        };

        let amm = AMM {
            user_lp_shares: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            net_base_asset_amount: 10 * AMM_RESERVE_PRECISION_I128,
            ..AMM::default_test()
        };
        let mut market = Market {
            amm,
            ..Market::default_test()
        };

        update_amm_and_lp_market_position(&mut market, &delta, 0).unwrap();

        assert_eq!(
            market.amm.market_position_per_lp.base_asset_amount,
            -10 * AMM_RESERVE_PRECISION_I128 / 100
        );
        assert_eq!(
            market.amm.market_position_per_lp.quote_asset_amount,
            10 * AMM_RESERVE_PRECISION_I128 / 100
        );
        assert_eq!(market.amm.net_base_asset_amount, 0);
        assert_eq!(
            market.amm.net_unsettled_lp_base_asset_amount,
            10 * AMM_RESERVE_PRECISION_I128
        );
    }

    #[test]
    fn half_half_amm_lp_split() {
        let delta = PositionDelta {
            base_asset_amount: 10 * AMM_RESERVE_PRECISION_I128,
            quote_asset_amount: -10 * AMM_RESERVE_PRECISION_I128,
        };

        let amm = AMM {
            user_lp_shares: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 200 * AMM_RESERVE_PRECISION,
            net_base_asset_amount: 10 * AMM_RESERVE_PRECISION_I128,
            ..AMM::default_test()
        };
        let mut market = Market {
            amm,
            ..Market::default_test()
        };

        update_amm_and_lp_market_position(&mut market, &delta, 0).unwrap();

        assert_eq!(
            market.amm.market_position_per_lp.base_asset_amount,
            -5 * AMM_RESERVE_PRECISION_I128 / 100
        );
        assert_eq!(
            market.amm.market_position_per_lp.quote_asset_amount,
            5 * AMM_RESERVE_PRECISION_I128 / 100
        );

        assert_eq!(
            market.amm.market_position.base_asset_amount,
            -5 * AMM_RESERVE_PRECISION_I128
        );
        assert_eq!(
            market.amm.market_position.quote_asset_amount,
            5 * AMM_RESERVE_PRECISION_I128
        );

        assert_eq!(
            market.amm.net_base_asset_amount,
            5 * AMM_RESERVE_PRECISION_I128
        );
        assert_eq!(
            market.amm.net_unsettled_lp_base_asset_amount,
            5 * AMM_RESERVE_PRECISION_I128
        );
    }

    #[test]
    fn increase_long_from_no_position() {
        let mut existing_position = MarketPosition::default();
        let position_delta = PositionDelta {
            base_asset_amount: 1,
            quote_asset_amount: -1,
        };
        let mut market = Market {
            amm: AMM {
                cumulative_funding_rate_long: 1,
                sqrt_k: 1,
                base_asset_amount_step_size: 1,
                ..AMM::default()
            },
            open_interest: 0,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 1);
        assert_eq!(existing_position.quote_asset_amount, -1);
        assert_eq!(existing_position.quote_entry_amount, -1);
        assert_eq!(pnl, 0);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 1);
        assert_eq!(market.base_asset_amount_short, 0);
        assert_eq!(market.amm.net_base_asset_amount, 0);
        assert_eq!(market.amm.quote_asset_amount_long, -1);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
        assert_eq!(market.amm.quote_entry_amount_long, -1);
        assert_eq!(market.amm.quote_entry_amount_short, 0);
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
                ..AMM::default_test()
            },
            open_interest: 0,
            ..Market::default_test()
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
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, 1);
        assert_eq!(market.amm.quote_entry_amount_long, 0);
        assert_eq!(market.amm.quote_entry_amount_short, 1);
    }

    #[test]
    fn increase_long() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 1,
            quote_asset_amount: -1,
            quote_entry_amount: -1,
            last_cumulative_funding_rate: 1,
            ..MarketPosition::default()
        };
        let position_delta = PositionDelta {
            base_asset_amount: 1,
            quote_asset_amount: -1,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: 1,
                quote_asset_amount_long: -1,
                quote_entry_amount_long: -1,
                cumulative_funding_rate_long: 1,
                ..AMM::default_test()
            },
            base_asset_amount_long: 1,
            base_asset_amount_short: 0,
            open_interest: 1,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 2);
        assert_eq!(existing_position.quote_asset_amount, -2);
        assert_eq!(existing_position.quote_entry_amount, -2);
        assert_eq!(pnl, 0);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 2);
        assert_eq!(market.base_asset_amount_short, 0);
        // assert_eq!(market.amm.net_base_asset_amount, 2);
        assert_eq!(market.amm.quote_asset_amount_long, -2);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
        assert_eq!(market.amm.quote_entry_amount_long, -2);
        assert_eq!(market.amm.quote_entry_amount_short, 0);
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
                quote_asset_amount_long: 0,
                quote_asset_amount_short: 1,
                quote_entry_amount_short: 1,
                cumulative_funding_rate_short: 1,
                ..AMM::default_test()
            },
            open_interest: 1,
            base_asset_amount_short: -1,
            base_asset_amount_long: 0,
            ..Market::default_test()
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
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, 2);
        assert_eq!(market.amm.quote_entry_amount_long, 0);
        assert_eq!(market.amm.quote_entry_amount_short, 2);
    }

    #[test]
    fn reduce_long_profitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 10,
            quote_asset_amount: -10,
            quote_entry_amount: -10,
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
                quote_asset_amount_long: -10,
                quote_entry_amount_long: -10,
                quote_asset_amount_short: 0,
                cumulative_funding_rate_long: 1,
                ..AMM::default_test()
            },
            open_interest: 1,
            base_asset_amount_long: 10,
            base_asset_amount_short: 0,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 9);
        assert_eq!(existing_position.quote_asset_amount, -5);
        assert_eq!(existing_position.quote_entry_amount, -9);
        assert_eq!(pnl, 4);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 9);
        assert_eq!(market.base_asset_amount_short, 0);
        // assert_eq!(market.amm.net_base_asset_amount, 9);
        assert_eq!(market.amm.quote_asset_amount_long, -5);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
        assert_eq!(market.amm.quote_entry_amount_long, -9);
        assert_eq!(market.amm.quote_entry_amount_short, 0);
    }

    #[test]
    fn reduce_long_unprofitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 10,
            quote_asset_amount: -100,
            quote_entry_amount: -100,
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
                quote_asset_amount_long: -100,
                quote_entry_amount_long: -100,
                quote_asset_amount_short: 0,
                cumulative_funding_rate_long: 1,
                ..AMM::default_test()
            },
            open_interest: 1,
            base_asset_amount_long: 10,
            base_asset_amount_short: 0,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 9);
        assert_eq!(existing_position.quote_asset_amount, -95);
        assert_eq!(existing_position.quote_entry_amount, -90);
        assert_eq!(pnl, -5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 9);
        assert_eq!(market.base_asset_amount_short, 0);
        // assert_eq!(market.amm.net_base_asset_amount, 9);
        assert_eq!(market.amm.quote_asset_amount_long, -95);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
        assert_eq!(market.amm.quote_entry_amount_long, -90);
        assert_eq!(market.amm.quote_entry_amount_short, 0);
    }

    #[test]
    fn flip_long_to_short_profitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 10,
            quote_asset_amount: -10,
            quote_entry_amount: -10,
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
                quote_asset_amount_long: -10,
                quote_entry_amount_long: -10,
                quote_asset_amount_short: 0,
                cumulative_funding_rate_short: 2,
                cumulative_funding_rate_long: 1,
                ..AMM::default_test()
            },
            open_interest: 1,
            base_asset_amount_long: 10,
            base_asset_amount_short: 0,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, -1);
        assert_eq!(existing_position.quote_asset_amount, 12);
        assert_eq!(existing_position.quote_entry_amount, 2);
        assert_eq!(pnl, 10);
        assert_eq!(existing_position.last_cumulative_funding_rate, 2);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -1);
        // assert_eq!(market.amm.net_base_asset_amount, -1);
        assert_eq!(market.amm.quote_asset_amount_long, 10);
        assert_eq!(market.amm.quote_asset_amount_short, 2);
        assert_eq!(market.amm.quote_entry_amount_long, 0);
        assert_eq!(market.amm.quote_entry_amount_short, 2);
    }

    #[test]
    fn flip_long_to_short_unprofitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 10,
            quote_asset_amount: -10,
            quote_entry_amount: -10,
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
                quote_asset_amount_long: -10,
                quote_entry_amount_long: -10,
                quote_asset_amount_short: 0,
                cumulative_funding_rate_short: 2,
                cumulative_funding_rate_long: 1,
                base_asset_amount_step_size: 1,
                ..AMM::default()
            },
            open_interest: 1,
            base_asset_amount_long: 10,
            base_asset_amount_short: 0,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, -1);
        assert_eq!(existing_position.quote_asset_amount, 0);
        assert_eq!(existing_position.quote_entry_amount, 1);
        assert_eq!(pnl, -1);
        assert_eq!(existing_position.last_cumulative_funding_rate, 2);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -1);
        // assert_eq!(market.amm.net_base_asset_amount, -1);
        assert_eq!(market.amm.quote_asset_amount_long, -1);
        assert_eq!(market.amm.quote_asset_amount_short, 1);
        assert_eq!(market.amm.quote_entry_amount_long, 0);
        assert_eq!(market.amm.quote_entry_amount_short, 1);
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
            quote_asset_amount: -5,
        };
        let mut market = Market {
            amm: AMM {
                quote_asset_amount_long: 0,
                quote_asset_amount_short: 100,
                quote_entry_amount_short: 100,
                cumulative_funding_rate_short: 1,
                ..AMM::default_test()
            },
            open_interest: 1,
            base_asset_amount_long: 0,
            base_asset_amount_short: -10,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, -9);
        assert_eq!(existing_position.quote_asset_amount, 95);
        assert_eq!(existing_position.quote_entry_amount, 90);
        assert_eq!(pnl, 5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -9);
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, 95);
        assert_eq!(market.amm.quote_entry_amount_long, 0);
        assert_eq!(market.amm.quote_entry_amount_short, 90);
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
            quote_asset_amount: -15,
        };
        let mut market = Market {
            amm: AMM {
                quote_asset_amount_long: 0,
                quote_asset_amount_short: 100,
                quote_entry_amount_short: 100,
                cumulative_funding_rate_short: 1,
                ..AMM::default_test()
            },
            open_interest: 1,
            base_asset_amount_long: 0,
            base_asset_amount_short: -10,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, -9);
        assert_eq!(existing_position.quote_asset_amount, 85);
        assert_eq!(existing_position.quote_entry_amount, 90);
        assert_eq!(pnl, -5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -9);
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, 85);
        assert_eq!(market.amm.quote_entry_amount_long, 0);
        assert_eq!(market.amm.quote_entry_amount_short, 90);
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
            quote_asset_amount: -60,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: -10,
                quote_asset_amount_long: 0,
                quote_asset_amount_short: 100,
                quote_entry_amount_short: 100,
                cumulative_funding_rate_long: 2,
                cumulative_funding_rate_short: 1,
                ..AMM::default_test()
            },
            open_interest: 1,
            base_asset_amount_long: 0,
            base_asset_amount_short: -10,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 1);
        assert_eq!(existing_position.quote_asset_amount, 40);
        assert_eq!(existing_position.quote_entry_amount, -6);
        assert_eq!(pnl, 46);
        assert_eq!(existing_position.last_cumulative_funding_rate, 2);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 1);
        assert_eq!(market.base_asset_amount_short, 0);
        // assert_eq!(market.amm.net_base_asset_amount, 1);
        assert_eq!(market.amm.quote_asset_amount_long, -6);
        assert_eq!(market.amm.quote_asset_amount_short, 46);
        assert_eq!(market.amm.quote_entry_amount_long, -6);
        assert_eq!(market.amm.quote_entry_amount_short, 0);
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
            quote_asset_amount: -120,
        };
        let mut market = Market {
            amm: AMM {
                net_base_asset_amount: -10,
                quote_asset_amount_long: 0,
                quote_asset_amount_short: 100,
                quote_entry_amount_short: 100,
                cumulative_funding_rate_long: 2,
                cumulative_funding_rate_short: 1,
                ..AMM::default_test()
            },
            open_interest: 1,
            base_asset_amount_long: 0,
            base_asset_amount_short: -10,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 1);
        assert_eq!(existing_position.quote_asset_amount, -20);
        assert_eq!(existing_position.quote_entry_amount, -11);
        assert_eq!(pnl, -9);
        assert_eq!(existing_position.last_cumulative_funding_rate, 2);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 1);
        assert_eq!(market.base_asset_amount_short, 0);
        // assert_eq!(market.amm.net_base_asset_amount, 1);
        assert_eq!(market.amm.quote_asset_amount_long, -11);
        assert_eq!(market.amm.quote_asset_amount_short, -9);
        assert_eq!(market.amm.quote_entry_amount_long, -11);
        assert_eq!(market.amm.quote_entry_amount_short, 0);
    }

    #[test]
    fn close_long_profitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 10,
            quote_asset_amount: -10,
            quote_entry_amount: -10,
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
                quote_asset_amount_long: -11,
                quote_entry_amount_long: -11,
                cumulative_funding_rate_long: 1,
                ..AMM::default_test()
            },
            open_interest: 2,
            base_asset_amount_long: 11,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 0);
        assert_eq!(existing_position.quote_asset_amount, 5);
        assert_eq!(existing_position.quote_entry_amount, 0);
        assert_eq!(pnl, 5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 0);
        assert_eq!(existing_position.last_funding_rate_ts, 0);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 1);
        assert_eq!(market.base_asset_amount_short, 0);
        // assert_eq!(market.amm.net_base_asset_amount, 1);
        // not 5 because quote asset amount long was -11 not -10 before
        assert_eq!(market.amm.quote_asset_amount_long, 4);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
        assert_eq!(market.amm.quote_entry_amount_long, -1);
        assert_eq!(market.amm.quote_entry_amount_short, 0);
    }

    #[test]
    fn close_long_unprofitable() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 10,
            quote_asset_amount: -10,
            quote_entry_amount: -10,
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
                quote_asset_amount_long: -11,
                quote_entry_amount_long: -11,
                cumulative_funding_rate_long: 1,
                ..AMM::default_test()
            },
            open_interest: 2,
            base_asset_amount_long: 11,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 0);
        assert_eq!(existing_position.quote_asset_amount, -5);
        assert_eq!(existing_position.quote_entry_amount, 0);
        assert_eq!(pnl, -5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 0);
        assert_eq!(existing_position.last_funding_rate_ts, 0);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 1);
        assert_eq!(market.base_asset_amount_short, 0);
        // assert_eq!(market.amm.net_base_asset_amount, 1);
        assert_eq!(market.amm.quote_asset_amount_long, -6);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
        assert_eq!(market.amm.quote_entry_amount_long, -1);
        assert_eq!(market.amm.quote_entry_amount_short, 0);
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
            quote_asset_amount: -5,
        };
        let mut market = Market {
            amm: AMM {
                quote_asset_amount_short: 11,
                quote_entry_amount_short: 11,
                cumulative_funding_rate_short: 1,
                ..AMM::default_test()
            },
            open_interest: 2,
            base_asset_amount_short: -11,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 0);
        assert_eq!(existing_position.quote_asset_amount, 5);
        assert_eq!(existing_position.quote_entry_amount, 0);
        assert_eq!(pnl, 5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 0);
        assert_eq!(existing_position.last_funding_rate_ts, 0);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -1);
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, 6);
        assert_eq!(market.amm.quote_entry_amount_long, 0);
        assert_eq!(market.amm.quote_entry_amount_short, 1);
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
            quote_asset_amount: -15,
        };
        let mut market = Market {
            amm: AMM {
                quote_asset_amount_short: 11,
                quote_entry_amount_short: 11,
                cumulative_funding_rate_short: 1,
                ..AMM::default_test()
            },
            open_interest: 2,
            base_asset_amount_short: -11,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 0);
        assert_eq!(existing_position.quote_asset_amount, -5);
        assert_eq!(existing_position.quote_entry_amount, 0);
        assert_eq!(pnl, -5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 0);
        assert_eq!(existing_position.last_funding_rate_ts, 0);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -1);
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, -4);
        assert_eq!(market.amm.quote_entry_amount_long, 0);
        assert_eq!(market.amm.quote_entry_amount_short, 1);
    }

    #[test]
    fn close_long_with_quote_entry_amount_less_than_quote_asset_amount() {
        let mut existing_position = MarketPosition {
            base_asset_amount: 10,
            quote_asset_amount: -10,
            quote_entry_amount: -8,
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
                quote_asset_amount_long: -11,
                quote_entry_amount_long: -8,
                cumulative_funding_rate_long: 1,
                base_asset_amount_step_size: 1,
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_long: 11,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 0);
        assert_eq!(existing_position.quote_asset_amount, -5);
        assert_eq!(existing_position.quote_entry_amount, 0);
        assert_eq!(pnl, -3);
        assert_eq!(existing_position.last_cumulative_funding_rate, 0);
        assert_eq!(existing_position.last_funding_rate_ts, 0);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 1);
        assert_eq!(market.base_asset_amount_short, 0);
        // assert_eq!(market.amm.net_base_asset_amount, 1);
        assert_eq!(market.amm.quote_asset_amount_long, -6);
        assert_eq!(market.amm.quote_asset_amount_short, 0);
        assert_eq!(market.amm.quote_entry_amount_long, 0);
        assert_eq!(market.amm.quote_entry_amount_short, 0);
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
            quote_asset_amount: -15,
        };
        let mut market = Market {
            amm: AMM {
                quote_asset_amount_short: 11,
                quote_entry_amount_short: 15,
                cumulative_funding_rate_short: 1,
                base_asset_amount_step_size: 1,
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_short: -11,
            ..Market::default_test()
        };

        let pnl = update_position_and_market(&mut existing_position, &mut market, &position_delta)
            .unwrap();

        assert_eq!(existing_position.base_asset_amount, 0);
        assert_eq!(existing_position.quote_asset_amount, -5);
        assert_eq!(existing_position.quote_entry_amount, 0);
        assert_eq!(pnl, 0);
        assert_eq!(existing_position.last_cumulative_funding_rate, 0);
        assert_eq!(existing_position.last_funding_rate_ts, 0);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -1);
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, -4);
        assert_eq!(market.amm.quote_entry_amount_long, 0);
        assert_eq!(market.amm.quote_entry_amount_short, 0);
    }
}
