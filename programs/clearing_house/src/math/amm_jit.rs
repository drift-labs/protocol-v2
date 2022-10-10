use solana_program::msg;

use crate::error::ClearingHouseResult;
use crate::math::casting::Cast;
use crate::math::orders::standardize_base_asset_amount;
use crate::math_error;
use crate::state::perp_market::PerpMarket;

#[cfg(test)]
mod tests;

// assumption: market.amm.amm_jit_is_active() == true
// assumption: taker_baa will improve market balance (see orders.rs & amm_wants_to_make)
pub fn calculate_jit_base_asset_amount(
    market: &PerpMarket,
    taker_base_asset_amount: u64,
) -> ClearingHouseResult<u64> {
    // simple impl
    // todo: dynamic on imbalance
    let mut jit_base_asset_amount = standardize_base_asset_amount(
        taker_base_asset_amount
            .checked_div(2)
            .ok_or_else(math_error!())?,
        market.amm.order_step_size,
    )?;

    if jit_base_asset_amount != 0 {
        jit_base_asset_amount =
            calculate_clampped_jit_base_asset_amount(market, jit_base_asset_amount)?;

        jit_base_asset_amount =
            standardize_base_asset_amount(jit_base_asset_amount, market.amm.order_step_size)?;
    }

    Ok(jit_base_asset_amount)
}

// assumption: taker_baa will improve market balance (see orders.rs & amm_wants_to_make)
// note: we split it into two (calc and clamp) bc its easier to maintain tests
pub fn calculate_clampped_jit_base_asset_amount(
    market: &PerpMarket,
    jit_base_asset_amount: u64,
) -> ClearingHouseResult<u64> {
    // apply intensity
    // todo more efficient method do here
    let jit_base_asset_amount = jit_base_asset_amount
        .cast::<u128>()?
        .checked_mul(market.amm.amm_jit_intensity as u128)
        .ok_or_else(math_error!())?
        .checked_div(100)
        .ok_or_else(math_error!())?
        .cast::<u64>()?;

    // bound it; dont flip the net_baa
    let max_amm_base_asset_amount = market
        .amm
        .base_asset_amount_with_amm
        .unsigned_abs()
        .cast::<u64>()?;
    let jit_base_asset_amount = jit_base_asset_amount.min(max_amm_base_asset_amount);

    Ok(jit_base_asset_amount)
}
