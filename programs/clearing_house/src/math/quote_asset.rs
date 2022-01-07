use crate::error::*;
use crate::math::constants::AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO;
use crate::math_error;
use solana_program::msg;
use std::ops::Div;

pub fn reserve_to_asset_amount(
    quote_asset_reserve: u128,
    peg_multiplier: u128,
) -> ClearingHouseResult<u128> {
    Ok(quote_asset_reserve
        .checked_mul(peg_multiplier)
        .ok_or_else(math_error!())?
        .div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO))
}

pub fn asset_to_reserve_amount(
    quote_asset_amount: u128,
    peg_multiplier: u128,
) -> ClearingHouseResult<u128> {
    Ok(quote_asset_amount
        .checked_mul(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO)
        .ok_or_else(math_error!())?
        .div(peg_multiplier))
}
