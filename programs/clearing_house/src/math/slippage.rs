use crate::error::ClearingHouseResult;
// use crate::error::{math_error};
use crate::math::casting::cast_to_i128;
use crate::math::constants::{
    BID_ASK_SPREAD_PRECISION_I128, MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO,
};
use crate::math_error;
use solana_program::msg;

pub fn calculate_slippage(
    exit_value: u128,
    base_asset_amount: u128,
    mark_price_before: i128,
) -> ClearingHouseResult<i128> {
    let amm_exit_price = exit_value
        .checked_mul(MARK_PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO)
        .ok_or_else(math_error!())?
        .checked_div(base_asset_amount)
        .ok_or_else(math_error!())?;

    cast_to_i128(amm_exit_price)?
        .checked_sub(mark_price_before)
        .ok_or_else(math_error!())
}

pub fn calculate_slippage_pct(
    slippage: i128,
    mark_price_before: i128,
) -> ClearingHouseResult<i128> {
    slippage
        .checked_mul(BID_ASK_SPREAD_PRECISION_I128)
        .ok_or_else(math_error!())?
        .checked_div(mark_price_before)
        .ok_or_else(math_error!())
}
