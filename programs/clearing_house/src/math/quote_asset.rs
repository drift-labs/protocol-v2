use crate::error::*;
use crate::math::constants::{AMM_TO_USDC_PRECION_RATIO, PEG_PRECISION};
use crate::math_error;
use solana_program::msg;

pub fn scale_to_amm_precision(quote_asset_amount: u128) -> ClearingHouseResult<u128> {
    let scaled_quote_asset_amount = quote_asset_amount
        .checked_mul(AMM_TO_USDC_PRECION_RATIO)
        .ok_or_else(math_error!())?;

    return Ok(scaled_quote_asset_amount);
}

pub fn unpeg_quote_asset_amount(
    quote_asset_amount: u128,
    peg_multiplier: u128,
) -> ClearingHouseResult<u128> {
    let unpegged_quote_asset_amount = quote_asset_amount
        .checked_mul(PEG_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(peg_multiplier)
        .ok_or_else(math_error!())?;

    return Ok(unpegged_quote_asset_amount);
}

pub fn scale_from_amm_precision(quote_asset_amount: u128) -> ClearingHouseResult<u128> {
    let scaled_quote_asset_amount = quote_asset_amount
        .checked_div(AMM_TO_USDC_PRECION_RATIO)
        .ok_or_else(math_error!())?;

    return Ok(scaled_quote_asset_amount);
}

pub fn peg_quote_asset_amount(
    quote_asset_amount: u128,
    peg_multiplier: u128,
) -> ClearingHouseResult<u128> {
    let unpegged_quote_asset_amount = quote_asset_amount
        .checked_mul(peg_multiplier)
        .ok_or_else(math_error!())?
        .checked_div(PEG_PRECISION)
        .ok_or_else(math_error!())?;

    return Ok(unpegged_quote_asset_amount);
}
