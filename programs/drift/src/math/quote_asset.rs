use crate::error::DriftResult;
use crate::math::constants::AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO;
use crate::math::safe_math::SafeMath;

use std::ops::Div;

pub fn reserve_to_asset_amount(
    quote_asset_reserve: u128,
    peg_multiplier: u128,
) -> DriftResult<u128> {
    Ok(quote_asset_reserve
        .safe_mul(peg_multiplier)?
        .div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO))
}

pub fn asset_to_reserve_amount(
    quote_asset_amount: u128,
    peg_multiplier: u128,
) -> DriftResult<u128> {
    Ok(quote_asset_amount
        .safe_mul(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO)?
        .div(peg_multiplier))
}
