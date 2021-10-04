use crate::error::*;
use crate::math::bn::U256;
use crate::math::constants::{MARK_PRICE_MANTISSA, PRICE_TO_PEG_PRECISION_RATIO};
use crate::math_error;
use crate::state::market::AMM;
use solana_program::msg;

pub fn calculate_repeg_candidate_pnl(
    amm: &AMM,
    new_peg_candidate: u128,
) -> ClearingHouseResult<i128> {
    let net_user_market_position = (amm.sqrt_k as i128)
        .checked_sub(amm.base_asset_reserve as i128)
        .ok_or_else(math_error!())?;

    let peg_spread_1 = (new_peg_candidate as i128)
        .checked_sub(amm.peg_multiplier as i128)
        .ok_or_else(math_error!())?;

    let peg_spread_direction: i128 = if peg_spread_1 > 0 { 1 } else { -1 };
    let market_position_bias_direction: i128 = if net_user_market_position > 0 { 1 } else { -1 };
    let pnl = (U256::from(
        peg_spread_1
            .unsigned_abs()
            .checked_mul(PRICE_TO_PEG_PRECISION_RATIO)
            .ok_or_else(math_error!())?,
    )
    .checked_mul(U256::from(net_user_market_position))
    .ok_or_else(math_error!())?
    .checked_mul(U256::from(amm.base_asset_price_with_mantissa()?))
    .ok_or_else(math_error!())?
    .checked_div(U256::from(MARK_PRICE_MANTISSA))
    .ok_or_else(math_error!())?
    .checked_div(U256::from(MARK_PRICE_MANTISSA))
    .ok_or_else(math_error!())?
    .checked_div(U256::from(MARK_PRICE_MANTISSA))
    .ok_or_else(math_error!())?
    .try_to_u128()? as i128)
        .checked_mul(
            market_position_bias_direction
                .checked_mul(peg_spread_direction)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    return Ok(pnl);
}

pub fn find_valid_repeg(
    amm: &AMM,
    oracle_px: i128,
    oracle_conf: u128,
) -> ClearingHouseResult<u128> {
    let peg_spread_0 = (amm.peg_multiplier as i128)
        .checked_mul(PRICE_TO_PEG_PRECISION_RATIO as i128)
        .ok_or_else(math_error!())?
        .checked_sub(oracle_px)
        .ok_or_else(math_error!())?;

    if peg_spread_0.unsigned_abs().lt(&oracle_conf) {
        return Ok(amm.peg_multiplier);
    }

    let mut i = 1; // max move is half way to oracle
    let mut new_peg_candidate = amm.peg_multiplier;

    while i < 20 {
        let base: i128 = 2;
        let step_fraction_size = base.pow(i);
        let step = peg_spread_0
            .checked_div(step_fraction_size)
            .ok_or_else(math_error!())?
            .checked_div(PRICE_TO_PEG_PRECISION_RATIO as i128)
            .ok_or_else(math_error!())?;

        if peg_spread_0 < 0 {
            new_peg_candidate = amm
                .peg_multiplier
                .checked_add(step.abs() as u128)
                .ok_or_else(math_error!())?;
        } else {
            new_peg_candidate = amm
                .peg_multiplier
                .checked_sub(step.abs() as u128)
                .ok_or_else(math_error!())?;
        }

        let pnl = calculate_repeg_candidate_pnl(amm, new_peg_candidate)?;
        let cum_pnl_profit = (amm.cumulative_fee_realized as i128)
            .checked_add(pnl)
            .ok_or_else(math_error!())?;

        if cum_pnl_profit
            >= amm
                .cumulative_fee
                .checked_div(2)
                .ok_or_else(math_error!())? as i128
        {
            break;
        }

        i = i + 1;
    }

    return Ok(new_peg_candidate);
}
