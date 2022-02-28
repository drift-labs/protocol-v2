use crate::controller::amm::SwapDirection;
use crate::error::ClearingHouseResult;
use crate::error::*;
use crate::math::casting::{cast, cast_to_i128};
use crate::math_error;
use solana_program::msg;

pub fn calculate_pnl(
    exit_value: u128,
    entry_value: u128,
    swap_direction_to_close: SwapDirection,
) -> ClearingHouseResult<i128> {
    Ok(match swap_direction_to_close {
        SwapDirection::Add => cast_to_i128(exit_value)?
            .checked_sub(cast(entry_value)?)
            .ok_or_else(math_error!())?,
        SwapDirection::Remove => cast_to_i128(entry_value)?
            .checked_sub(cast(exit_value)?)
            .ok_or_else(math_error!())?,
    })
}
