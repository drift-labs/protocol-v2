use crate::controller::amm::SwapDirection;
use crate::error::*;
use crate::math::bn::U256;
use crate::math::constants::{MARK_ORACLE_DIVERGENCE_MANTISSA, MARK_PRICE_MANTISSA, PEG_PRECISION};
use crate::math_error;
use crate::state::market::AMM;
use crate::state::state::{OpenPositionOracleGuardRails, ValidOracleGuardRails};
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
    clock_slot: u64,
) -> ClearingHouseResult<(i128, i128)> {
    let mark_price: i128;
    if window > 0 {
        mark_price = amm.last_mark_price_twap as i128;
    } else {
        mark_price = amm.mark_price()? as i128;
    }

    let (oracle_price, _oracle_conf, _oracle_delay) =
        amm.get_oracle_price(price_oracle, window, clock_slot)?;

    let price_spread = mark_price
        .checked_sub(oracle_price)
        .ok_or_else(math_error!())?;

    Ok((oracle_price, price_spread))
}

pub fn calculate_oracle_mark_spread_pct(
    amm: &AMM,
    price_oracle: &AccountInfo,
    window: u32,
    clock_slot: u64,
) -> ClearingHouseResult<i128> {
    let (oracle_price, price_spread) =
        calculate_oracle_mark_spread(amm, price_oracle, window, clock_slot).unwrap();

    let price_spread_pct = price_spread
        .checked_mul(MARK_ORACLE_DIVERGENCE_MANTISSA as i128)
        .ok_or_else(math_error!())?
        .checked_div(oracle_price)
        .ok_or_else(math_error!())?;

    Ok(price_spread_pct)
}

pub fn is_oracle_mark_limit(
    price_spread_pct: i128,
    oracle_guard_rails: &OpenPositionOracleGuardRails,
) -> ClearingHouseResult<bool> {
    let max_divergence = MARK_ORACLE_DIVERGENCE_MANTISSA
        .checked_mul(oracle_guard_rails.mark_oracle_divergence_numerator)
        .ok_or_else(math_error!())?
        .checked_div(oracle_guard_rails.mark_oracle_divergence_denominator)
        .ok_or_else(math_error!())?;

    Ok(price_spread_pct.unsigned_abs() > max_divergence)
}

pub fn is_oracle_valid(
    amm: &AMM,
    price_oracle: &AccountInfo,
    clock_slot: u64,
    valid_oracle_guard_rails: &ValidOracleGuardRails,
) -> ClearingHouseResult<bool> {
    let (oracle_price, oracle_conf, oracle_delay) =
        amm.get_oracle_price(price_oracle, 0, clock_slot)?;

    let (oracle_twap, oracle_twap_conf, _oracle_delay) =
        amm.get_oracle_price(price_oracle, 60 * 60, clock_slot)?;

    let is_oracle_price_nonpositive = (oracle_twap <= 0) || (oracle_price <= 0);
    assert_eq!(is_oracle_price_nonpositive, false);
    
    let is_oracle_price_too_volatile = ((oracle_price
        .checked_div(max(1, oracle_twap))
        .ok_or_else(math_error!())?)
    .gt(&5))
        || ((oracle_twap
            .checked_div(max(1,oracle_price))
            .ok_or_else(math_error!())?)
        .gt(&5));

    let conf_denom_of_price = (oracle_price as u128)
        .checked_div(max(1, oracle_conf))
        .ok_or_else(math_error!())?;
    let conf_denom_of_twap_price = (oracle_twap as u128)
        .checked_div(max(1, oracle_twap_conf))
        .ok_or_else(math_error!())?;
    let is_conf_too_large = (conf_denom_of_price
        .lt(&valid_oracle_guard_rails.confidence_interval_max_size))
        || (conf_denom_of_twap_price.lt(&valid_oracle_guard_rails.confidence_interval_max_size));

    let is_stale = oracle_delay.gt(&valid_oracle_guard_rails.slots_before_stale);

    Ok(!(is_stale || is_conf_too_large || is_oracle_price_nonpositive || is_oracle_price_too_volatile))
}
