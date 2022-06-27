use crate::math::casting::cast_to_i128;
use crate::math_error;
use anchor_lang::prelude::*;
use solana_program::msg;

pub fn get_proportion(value: i128, numerator: u128, denominator: u128) -> Result<i128> {
    let _sign: i128 = if value > 0 { 1 } else { -1 };
    let proportional_value = cast_to_i128(
        value
            .unsigned_abs()
            .checked_mul(numerator)
            .ok_or_else(math_error!())?
            .checked_div(denominator)
            .ok_or_else(math_error!())?,
    )?
    .checked_mul(_sign)
    .ok_or_else(math_error!())?;
    Ok(proportional_value)
}
