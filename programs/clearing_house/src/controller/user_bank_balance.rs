use crate::controller::position::PositionDirection;
use crate::error::ClearingHouseResult;
use crate::math::casting::cast;
use crate::math_error;
use crate::state::user::UserBankBalance;
use solana_program::msg;

pub fn increase_spot_open_bids_and_asks(
    bank_balance: &mut UserBankBalance,
    direction: &PositionDirection,
    base_asset_amount_unfilled: u128,
) -> ClearingHouseResult {
    match direction {
        PositionDirection::Long => {
            bank_balance.open_bids = bank_balance
                .open_bids
                .checked_add(cast(base_asset_amount_unfilled)?)
                .ok_or_else(math_error!())?;
        }
        PositionDirection::Short => {
            bank_balance.open_asks = bank_balance
                .open_asks
                .checked_sub(cast(base_asset_amount_unfilled)?)
                .ok_or_else(math_error!())?;
        }
    }

    Ok(())
}
