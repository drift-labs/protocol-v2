use crate::controller::amm::SwapDirection;
use crate::error::*;
use crate::math::bn::U256;
use crate::math::constants::{
    AMM_ASSET_AMOUNT_PRECISION, MARK_PRICE_MANTISSA, PEG_PRECISION, PRICE_TO_PEG_PRECISION_RATIO,
    USDC_PRECISION,
};
use crate::math_error;
use crate::state::market::AMM;
use anchor_lang::prelude::AccountInfo;
use solana_program::msg;
use std::cmp::max;

pub fn calculate_price(
    unpegged_quote_asset_amount: u128,
    base_asset_amount: u128,
    peg_multiplier: u128,
) -> ClearingHouseResult<u128> {
    let peg_quote_asset_amount = unpegged_quote_asset_amount
        .checked_mul(peg_multiplier)
        .ok_or_else(math_error!())?;

    return U256::from(peg_quote_asset_amount)
        .checked_mul(U256::from(
            MARK_PRICE_MANTISSA
                .checked_div(PEG_PRECISION)
                .ok_or_else(math_error!())?,
        ))
        .ok_or_else(math_error!())?
        .checked_div(U256::from(base_asset_amount))
        .ok_or_else(math_error!())?
        .try_to_u128();
}

pub fn calculate_new_mark_twap(amm: &AMM, now: i64) -> ClearingHouseResult<u128> {
    let since_last = max(1, now - amm.last_mark_price_twap_ts);
    let since_start = max(1, amm.last_mark_price_twap_ts - amm.last_funding_rate_ts);
    let denominator = (since_last + since_start) as u128;

    let prev_twap_99 = amm
        .last_mark_price_twap
        .checked_mul(since_start as u128)
        .ok_or_else(math_error!())?;
    let latest_price_01 = amm
        .mark_price()?
        .checked_mul(since_last as u128)
        .ok_or_else(math_error!())?;
    let new_twap = prev_twap_99
        .checked_add(latest_price_01 as u128)
        .ok_or_else(math_error!())?
        .checked_div(denominator)
        .ok_or_else(math_error!());
    return new_twap;
}

pub fn calculate_swap_output(
    swap_amount: u128,
    input_asset_amount: u128,
    direction: SwapDirection,
    invariant_sqrt: u128,
) -> ClearingHouseResult<(u128, u128)> {
    let invariant_sqrt_u256 = U256::from(invariant_sqrt);
    let invariant = invariant_sqrt_u256
        .checked_mul(invariant_sqrt_u256)
        .ok_or_else(math_error!())?;

    let new_input_amount = if let SwapDirection::Add = direction {
        input_asset_amount
            .checked_add(swap_amount)
            .ok_or_else(math_error!())?
    } else {
        input_asset_amount
            .checked_sub(swap_amount)
            .ok_or_else(math_error!())?
    };

    let new_output_amount = invariant
        .checked_div(U256::from(new_input_amount))
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    return Ok((new_output_amount, new_input_amount));
}

pub fn calculate_oracle_mark_spread(
    amm: &AMM,
    price_oracle: &AccountInfo,
    window: u32,
) -> ClearingHouseResult<i128> {
    let mark_price: i128;
    if window > 0 {
        mark_price = amm.last_mark_price_twap as i128;
    } else {
        mark_price = amm.mark_price()? as i128;
    }

    let (oracle_price, _oracle_conf) = amm.get_oracle_price(price_oracle, window)?;

    let price_spread = mark_price
        .checked_sub(oracle_price)
        .ok_or_else(math_error!())?;

    Ok(price_spread)
}
