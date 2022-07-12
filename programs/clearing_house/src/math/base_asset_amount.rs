use crate::controller::position::PositionDirection;
use crate::error::ClearingHouseResult;
use crate::math::casting::cast_to_i128;

pub fn get_signed_base_asset_amount(
    base_asset_amount: u128,
    direction: PositionDirection,
) -> ClearingHouseResult<i128> {
    match direction {
        PositionDirection::Long => cast_to_i128(base_asset_amount),
        PositionDirection::Short => cast_to_i128(base_asset_amount).map(|x| -x),
    }
}
