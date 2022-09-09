use crate::controller::position::PositionDirection;
use crate::error::ClearingHouseResult;
use crate::math::casting::cast;
use crate::math_error;
use crate::state::user::SpotPosition;
use solana_program::msg;

pub fn increase_spot_open_bids_and_asks(
    spot_position: &mut SpotPosition,
    direction: &PositionDirection,
    base_asset_amount_unfilled: u128,
) -> ClearingHouseResult {
    match direction {
        PositionDirection::Long => {
            spot_position.open_bids = spot_position
                .open_bids
                .checked_add(cast(base_asset_amount_unfilled)?)
                .ok_or_else(math_error!())?;
        }
        PositionDirection::Short => {
            spot_position.open_asks = spot_position
                .open_asks
                .checked_sub(cast(base_asset_amount_unfilled)?)
                .ok_or_else(math_error!())?;
        }
    }

    Ok(())
}

pub fn decrease_spot_open_bids_and_asks(
    spot_position: &mut SpotPosition,
    direction: &PositionDirection,
    base_asset_amount_unfilled: u128,
) -> ClearingHouseResult {
    match direction {
        PositionDirection::Long => {
            spot_position.open_bids = spot_position
                .open_bids
                .checked_sub(cast(base_asset_amount_unfilled)?)
                .ok_or_else(math_error!())?;
        }
        PositionDirection::Short => {
            spot_position.open_asks = spot_position
                .open_asks
                .checked_add(cast(base_asset_amount_unfilled)?)
                .ok_or_else(math_error!())?;
        }
    }

    Ok(())
}
