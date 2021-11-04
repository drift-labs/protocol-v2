use crate::error::*;
use crate::math::constants::{AMM_TO_COLLATERAL_PRECISION_RATIO, PEG_PRECISION};
use crate::math_error;
use solana_program::msg;

pub fn scale_to_amm_precision(quote_asset_amount: u128) -> ClearingHouseResult<u128> {
    let scaled_quote_asset_amount = quote_asset_amount
        .checked_mul(AMM_TO_COLLATERAL_PRECISION_RATIO)
        .ok_or_else(math_error!())?;

    return Ok(scaled_quote_asset_amount);
}

/// If the user goes short, the exchange needs to round up after integer division. Otherwise the user
/// is assigned extra PnL
pub fn unpeg_quote_asset_amount(
    quote_asset_amount: u128,
    peg_multiplier: u128,
    round_up: bool,
) -> ClearingHouseResult<u128> {
    let unpegged_quote_asset_amount_intermediate = quote_asset_amount
        .checked_mul(PEG_PRECISION)
        .ok_or_else(math_error!())?;

    let mut unpegged_quote_asset_amount = unpegged_quote_asset_amount_intermediate
        .checked_div(peg_multiplier)
        .ok_or_else(math_error!())?;

    if round_up
        && unpegged_quote_asset_amount_intermediate
            .checked_rem(peg_multiplier)
            .is_some()
    {
        unpegged_quote_asset_amount = unpegged_quote_asset_amount
            .checked_add(1)
            .ok_or_else(math_error!())?;
    }

    return Ok(unpegged_quote_asset_amount);
}

/// If the user goes short, the exchange needs to round up after integer division. Otherwise the user
/// is assigned extra PnL
pub fn scale_from_amm_precision(
    quote_asset_amount: u128,
    round_up: bool,
) -> ClearingHouseResult<u128> {
    let mut scaled_quote_asset_amount = quote_asset_amount
        .checked_div(AMM_TO_COLLATERAL_PRECISION_RATIO)
        .ok_or_else(math_error!())?;

    if round_up
        && quote_asset_amount
            .checked_rem(AMM_TO_COLLATERAL_PRECISION_RATIO)
            .is_some()
    {
        scaled_quote_asset_amount = scaled_quote_asset_amount
            .checked_add(1)
            .ok_or_else(math_error!())?;
    }

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
