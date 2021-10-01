use anchor_lang::prelude::AccountInfo;
use std::cmp::max;

use crate::controller::amm::SwapDirection;
use crate::math::bn::U256;
use crate::math::constants::{MARK_PRICE_MANTISSA, PEG_PRECISION};
use crate::state::market::AMM;

pub fn calculate_base_asset_price_with_mantissa(
    unpegged_quote_asset_amount: u128,
    base_asset_amount: u128,
    peg_multiplier: u128,
) -> u128 {
    let peg_quote_asset_amount = unpegged_quote_asset_amount
        .checked_mul(peg_multiplier)
        .unwrap();

    let ast_px = U256::from(peg_quote_asset_amount)
        .checked_mul(U256::from(
            MARK_PRICE_MANTISSA.checked_div(PEG_PRECISION).unwrap(),
        ))
        .unwrap()
        .checked_div(U256::from(base_asset_amount))
        .unwrap()
        .try_to_u128()
        .unwrap();

    return ast_px;
}

pub fn calculate_new_mark_twap(amm: &AMM, now: i64) -> u128 {
    let since_last = max(1, now - amm.last_mark_price_twap_ts);
    let since_start = max(1, amm.last_mark_price_twap_ts - amm.last_funding_rate_ts);
    let denominator = (since_last + since_start) as u128;

    let prev_twap_99 = amm
        .last_mark_price_twap
        .checked_mul(since_start as u128)
        .unwrap();
    let latest_price_01 = amm
        .base_asset_price_with_mantissa()
        .checked_mul(since_last as u128)
        .unwrap();
    let new_twap = prev_twap_99
        .checked_add(latest_price_01 as u128)
        .unwrap()
        .checked_div(denominator)
        .unwrap();
    return new_twap;
}

pub fn calculate_swap_output(
    swap_amount: u128,
    input_asset_amount: u128,
    direction: SwapDirection,
    invariant_sqrt: u128,
) -> Option<(u128, u128)> {
    let invariant_sqrt_u256 = U256::from(invariant_sqrt);
    let invariant = invariant_sqrt_u256.checked_mul(invariant_sqrt_u256)?;

    let new_input_amount = if let SwapDirection::Add = direction {
        input_asset_amount.checked_add(swap_amount)?
    } else {
        input_asset_amount.checked_sub(swap_amount)?
    };

    let new_output_amount = invariant
        .checked_div(U256::from(new_input_amount))?
        .try_to_u128()
        .unwrap();

    return Option::Some((new_output_amount, new_input_amount));
}

pub fn calculate_oracle_mark_spread(amm: &AMM, price_oracle: &AccountInfo, window: u32) -> i128 {
    let mark_price: i128;
    if window > 0 {
        mark_price = amm.last_mark_price_twap as i128;
    } else {
        mark_price = amm.base_asset_price_with_mantissa() as i128;
    }

    let (oracle_price, _oracle_conf) = amm.get_oracle_price(price_oracle, window);

    let price_spread = mark_price.checked_sub(oracle_price).unwrap();

    return price_spread;
}
