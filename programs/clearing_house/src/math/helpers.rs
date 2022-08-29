use crate::error::ClearingHouseResult;
use crate::math::casting::cast_to_i128;
use crate::math_error;
use solana_program::msg;

pub fn get_proportion_i128(
    value: i128,
    numerator: u128,
    denominator: u128,
) -> ClearingHouseResult<i128> {
    let proportional_value = cast_to_i128(
        value
            .unsigned_abs()
            .checked_mul(numerator)
            .ok_or_else(math_error!())?
            .checked_div(denominator)
            .ok_or_else(math_error!())?,
    )?
    .checked_mul(value.signum())
    .ok_or_else(math_error!())?;
    Ok(proportional_value)
}

pub fn get_proportion_u128(
    value: u128,
    numerator: u128,
    denominator: u128,
) -> ClearingHouseResult<u128> {
    let proportional_value = if numerator > denominator / 2 {
        value
            .checked_sub(
                value
                    .checked_mul(denominator - numerator)
                    .ok_or_else(math_error!())?
                    .checked_div(denominator)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?
    } else {
        value
            .checked_mul(numerator)
            .ok_or_else(math_error!())?
            .checked_div(denominator)
            .ok_or_else(math_error!())?
    };

    Ok(proportional_value)
}
