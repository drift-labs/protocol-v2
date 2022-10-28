use crate::controller::amm::SwapDirection;
use crate::error::DriftResult;
use crate::math::casting::Cast;
use crate::math::safe_math::SafeMath;

pub fn calculate_pnl(
    exit_value: u128,
    entry_value: u128,
    swap_direction_to_close: SwapDirection,
) -> DriftResult<i128> {
    match swap_direction_to_close {
        SwapDirection::Add => exit_value.cast::<i128>()?.safe_sub(entry_value.cast()?),
        SwapDirection::Remove => entry_value.cast::<i128>()?.safe_sub(exit_value.cast()?),
    }
}
