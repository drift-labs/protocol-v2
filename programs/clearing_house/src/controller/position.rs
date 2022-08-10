use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;

use crate::controller;
use crate::controller::amm::SwapDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::casting::cast;
use crate::math::orders::{
    calculate_quote_asset_amount_for_maker_order, get_position_delta_for_fill,
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

pub struct PositionDelta {
    pub quote_asset_amount: i128,
    pub base_asset_amount: i128,
}

enum PositionUpdateType {
    Open,
    Increase,
    Reduce,
    Close,
    Flip,
}

fn get_position_update_type(
    position: &MarketPosition,
    delta: &PositionDelta,
) -> PositionUpdateType {
    if position.base_asset_amount == 0 {
        PositionUpdateType::Open
    } else if position.base_asset_amount.signum() == delta.base_asset_amount.signum() {
        PositionUpdateType::Increase
    } else if position.base_asset_amount.abs() > delta.base_asset_amount.abs() {
        PositionUpdateType::Reduce
    } else if position.base_asset_amount.abs() == delta.base_asset_amount.abs() {
        PositionUpdateType::Close
    } else {
        PositionUpdateType::Flip
    }
}

pub fn update_position_and_market(
    position: &mut MarketPosition,
    market: &mut Market,
    delta: &PositionDelta,
) -> ClearingHouseResult<i128> {
    validate!(
        delta.base_asset_amount != 0 && delta.quote_asset_amount != 0,
        ErrorCode::InvalidPositionDelta,
        "delta.base_asset_amount {} delta.quote_asset_amount {}",
        delta.base_asset_amount,
        delta.quote_asset_amount,
    )?;

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

    // Update Market
    market.amm.net_base_asset_amount = market
        .amm
        .net_base_asset_amount
        .checked_add(delta.base_asset_amount)
        .ok_or_else(math_error!())?;

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

    position.quote_asset_amount = new_quote_asset_amount;
    position.quote_entry_amount = new_quote_entry_amount;
    position.base_asset_amount = new_base_asset_amount;

    Ok(pnl)
}

pub fn update_position_with_base_asset_amount(
    base_asset_amount: u128,
    direction: PositionDirection,
    market: &mut Market,
    user: &mut User,
    position_index: usize,
    mark_price_before: u128,
    now: i64,
    maker_limit_price: Option<u128>,
) -> ClearingHouseResult<(bool, u128, u128, u128, i128)> {
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

    let (quote_asset_amount, quote_asset_amount_surplus) = match maker_limit_price {
        Some(limit_price) => calculate_quote_asset_amount_surplus(
            swap_direction,
            quote_asset_swapped,
            base_asset_amount,
            limit_price,
        )?,
        None => (quote_asset_swapped, quote_asset_amount_surplus),
    };

    let position_delta =
        get_position_delta_for_fill(base_asset_amount, quote_asset_amount, direction)?;

    let base_asset_amount_before = user.positions[position_index].base_asset_amount;

    let potentially_risk_increasing = base_asset_amount_before == 0
        || base_asset_amount_before.signum() == position_delta.base_asset_amount.signum()
        || base_asset_amount_before.abs() < position_delta.base_asset_amount.abs();

    let pnl =
        update_position_and_market(&mut user.positions[position_index], market, &position_delta)?;

    Ok((
        potentially_risk_increasing,
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
    use crate::controller::position::{update_position_and_market, PositionDelta};
    use crate::state::market::{Market, AMM};
    use crate::state::user::MarketPosition;

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
                ..AMM::default()
            },
            open_interest: 0,
            ..Market::default()
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
        assert_eq!(market.amm.net_base_asset_amount, 1);
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
        assert_eq!(existing_position.quote_asset_amount, -2);
        assert_eq!(existing_position.quote_entry_amount, -2);
        assert_eq!(pnl, 0);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 2);
        assert_eq!(market.base_asset_amount_short, 0);
        assert_eq!(market.amm.net_base_asset_amount, 2);
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
                net_base_asset_amount: -1,
                quote_asset_amount_long: 0,
                quote_asset_amount_short: 1,
                quote_entry_amount_short: 1,
                cumulative_funding_rate_short: 1,
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
        assert_eq!(existing_position.quote_asset_amount, -5);
        assert_eq!(existing_position.quote_entry_amount, -9);
        assert_eq!(pnl, 4);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 9);
        assert_eq!(market.base_asset_amount_short, 0);
        assert_eq!(market.amm.net_base_asset_amount, 9);
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
        assert_eq!(existing_position.quote_asset_amount, -95);
        assert_eq!(existing_position.quote_entry_amount, -90);
        assert_eq!(pnl, -5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 9);
        assert_eq!(market.base_asset_amount_short, 0);
        assert_eq!(market.amm.net_base_asset_amount, 9);
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
        assert_eq!(existing_position.quote_asset_amount, 12);
        assert_eq!(existing_position.quote_entry_amount, 2);
        assert_eq!(pnl, 10);
        assert_eq!(existing_position.last_cumulative_funding_rate, 2);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -1);
        assert_eq!(market.amm.net_base_asset_amount, -1);
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
        assert_eq!(existing_position.quote_asset_amount, 0);
        assert_eq!(existing_position.quote_entry_amount, 1);
        assert_eq!(pnl, -1);
        assert_eq!(existing_position.last_cumulative_funding_rate, 2);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -1);
        assert_eq!(market.amm.net_base_asset_amount, -1);
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
                net_base_asset_amount: -10,
                quote_asset_amount_long: 0,
                quote_asset_amount_short: 100,
                quote_entry_amount_short: 100,
                cumulative_funding_rate_short: 1,
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
        assert_eq!(existing_position.quote_asset_amount, 95);
        assert_eq!(existing_position.quote_entry_amount, 90);
        assert_eq!(pnl, 5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -9);
        assert_eq!(market.amm.net_base_asset_amount, -9);
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
                net_base_asset_amount: -10,
                quote_asset_amount_long: 0,
                quote_asset_amount_short: 100,
                quote_entry_amount_short: 100,
                cumulative_funding_rate_short: 1,
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
        assert_eq!(existing_position.quote_asset_amount, 85);
        assert_eq!(existing_position.quote_entry_amount, 90);
        assert_eq!(pnl, -5);
        assert_eq!(existing_position.last_cumulative_funding_rate, 1);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 0);
        assert_eq!(market.base_asset_amount_short, -9);
        assert_eq!(market.amm.net_base_asset_amount, -9);
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
        assert_eq!(existing_position.quote_asset_amount, 40);
        assert_eq!(existing_position.quote_entry_amount, -6);
        assert_eq!(pnl, 46);
        assert_eq!(existing_position.last_cumulative_funding_rate, 2);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 1);
        assert_eq!(market.base_asset_amount_short, 0);
        assert_eq!(market.amm.net_base_asset_amount, 1);
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
        assert_eq!(existing_position.quote_asset_amount, -20);
        assert_eq!(existing_position.quote_entry_amount, -11);
        assert_eq!(pnl, -9);
        assert_eq!(existing_position.last_cumulative_funding_rate, 2);

        assert_eq!(market.open_interest, 1);
        assert_eq!(market.base_asset_amount_long, 1);
        assert_eq!(market.base_asset_amount_short, 0);
        assert_eq!(market.amm.net_base_asset_amount, 1);
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
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_long: 11,
            ..Market::default()
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
        assert_eq!(market.amm.net_base_asset_amount, 1);
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
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_long: 11,
            ..Market::default()
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
        assert_eq!(market.amm.net_base_asset_amount, 1);
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
                net_base_asset_amount: -11,
                quote_asset_amount_short: 11,
                quote_entry_amount_short: 11,
                cumulative_funding_rate_short: 1,
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_short: -11,
            ..Market::default()
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
        assert_eq!(market.amm.net_base_asset_amount, -1);
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
                net_base_asset_amount: -11,
                quote_asset_amount_short: 11,
                quote_entry_amount_short: 11,
                cumulative_funding_rate_short: 1,
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_short: -11,
            ..Market::default()
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
        assert_eq!(market.amm.net_base_asset_amount, -1);
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
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_long: 11,
            ..Market::default()
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
        assert_eq!(market.amm.net_base_asset_amount, 1);
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
                net_base_asset_amount: -11,
                quote_asset_amount_short: 11,
                quote_entry_amount_short: 15,
                cumulative_funding_rate_short: 1,
                ..AMM::default()
            },
            open_interest: 2,
            base_asset_amount_short: -11,
            ..Market::default()
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
        assert_eq!(market.amm.net_base_asset_amount, -1);
        assert_eq!(market.amm.quote_asset_amount_long, 0);
        assert_eq!(market.amm.quote_asset_amount_short, -4);
        assert_eq!(market.amm.quote_entry_amount_long, 0);
        assert_eq!(market.amm.quote_entry_amount_short, 0);
    }
}
