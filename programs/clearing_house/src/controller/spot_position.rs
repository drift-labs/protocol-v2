use solana_program::msg;

use crate::controller::position::PositionDirection;
use crate::controller::spot_balance::update_spot_balances;
use crate::error::ClearingHouseResult;
use crate::error::ErrorCode;
use crate::math::casting::{cast, Cast};
use crate::math::safe_math::SafeMath;
use crate::math_error;
use crate::safe_decrement;
use crate::safe_increment;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::user::SpotPosition;
use crate::validate;

#[cfg(test)]
mod tests;

pub fn increase_spot_open_bids_and_asks(
    spot_position: &mut SpotPosition,
    direction: &PositionDirection,
    base_asset_amount_unfilled: u64,
) -> ClearingHouseResult {
    match direction {
        PositionDirection::Long => {
            spot_position.open_bids = spot_position
                .open_bids
                .safe_add(base_asset_amount_unfilled.cast()?)?;
        }
        PositionDirection::Short => {
            spot_position.open_asks = spot_position
                .open_asks
                .safe_sub(base_asset_amount_unfilled.cast()?)?;
        }
    }

    Ok(())
}

pub fn decrease_spot_open_bids_and_asks(
    spot_position: &mut SpotPosition,
    direction: &PositionDirection,
    base_asset_amount_unfilled: u64,
) -> ClearingHouseResult {
    match direction {
        PositionDirection::Long => {
            spot_position.open_bids = spot_position
                .open_bids
                .safe_sub(base_asset_amount_unfilled.cast()?)?;
        }
        PositionDirection::Short => {
            spot_position.open_asks = spot_position
                .open_asks
                .safe_add(base_asset_amount_unfilled.cast()?)?;
        }
    }

    Ok(())
}

pub fn update_spot_balances_and_cumulative_deposits(
    token_amount: u128,
    update_direction: &SpotBalanceType,
    spot_market: &mut SpotMarket,
    spot_position: &mut SpotPosition,
    force_round_up: bool,
    cumulative_deposit_delta: Option<u128>,
) -> ClearingHouseResult {
    update_spot_balances(
        token_amount,
        update_direction,
        spot_market,
        spot_position,
        force_round_up,
    )?;

    let cumulative_deposit_delta = cumulative_deposit_delta.unwrap_or(token_amount);
    match update_direction {
        SpotBalanceType::Deposit => {
            safe_increment!(
                spot_position.cumulative_deposits,
                cast(cumulative_deposit_delta)?
            )
        }
        SpotBalanceType::Borrow => {
            safe_decrement!(
                spot_position.cumulative_deposits,
                cast(cumulative_deposit_delta)?
            )
        }
    }

    Ok(())
}

pub fn transfer_spot_position_deposit(
    token_amount: i128,
    spot_market: &mut SpotMarket,
    from_spot_position: &mut SpotPosition,
    to_spot_position: &mut SpotPosition,
) -> ClearingHouseResult {
    validate!(
        from_spot_position.market_index == to_spot_position.market_index,
        ErrorCode::DefaultError,
        "transfer market indexes arent equal",
    )?;

    update_spot_balances_and_cumulative_deposits(
        token_amount.unsigned_abs(),
        if token_amount > 0 {
            &SpotBalanceType::Borrow
        } else {
            &SpotBalanceType::Deposit
        },
        spot_market,
        from_spot_position,
        false,
        None,
    )?;

    update_spot_balances_and_cumulative_deposits(
        token_amount.unsigned_abs(),
        if token_amount > 0 {
            &SpotBalanceType::Deposit
        } else {
            &SpotBalanceType::Borrow
        },
        spot_market,
        to_spot_position,
        false,
        None,
    )?;

    Ok(())
}
