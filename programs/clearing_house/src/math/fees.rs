use crate::error::*;
use crate::math_error;
use solana_program::msg;

pub fn calculate(
    quote_asset_amount: u128,
    fee_numerator: u128,
    fee_denominator: u128,
) -> ClearingHouseResult<u128> {
    return Ok(quote_asset_amount
        .checked_mul(fee_numerator)
        .ok_or_else(math_error!())?
        .checked_div(fee_denominator)
        .ok_or_else(math_error!())?);
}
