use std::cmp::max;

use crate::controller::amm::SwapDirection;
use crate::math::bn::U256;
use crate::math::constants::{MARK_PRICE_MANTISSA, PEG_PRECISION, PRICE_TO_PEG_PRECISION_RATIO};
use crate::state::market::AMM;
use anchor_lang::prelude::AccountInfo;

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

pub fn find_valid_repeg(amm: &AMM, oracle_px: i128, oracle_conf: u128) -> u128 {
    let peg_spread_0 = (amm.peg_multiplier as i128)
        .checked_mul(PRICE_TO_PEG_PRECISION_RATIO as i128)
        .unwrap()
        .checked_sub(oracle_px)
        .unwrap();

    if peg_spread_0.unsigned_abs().lt(&oracle_conf) {
        return amm.peg_multiplier;
    }

    let mut i = 1; // max move is half way to oracle
    let mut new_peg_candidate = amm.peg_multiplier;

    while i < 20 {
        let base: i128 = 2;
        let step_fraction_size = base.pow(i);
        let step = peg_spread_0
            .checked_div(step_fraction_size)
            .unwrap()
            .checked_div(PRICE_TO_PEG_PRECISION_RATIO as i128)
            .unwrap();

        if peg_spread_0 < 0 {
            new_peg_candidate = amm.peg_multiplier.checked_add(step.abs() as u128).unwrap();
        } else {
            new_peg_candidate = amm.peg_multiplier.checked_sub(step.abs() as u128).unwrap();
        }

        let pnl = calculate_repeg_candidate_pnl(amm, new_peg_candidate);
        let cum_pnl_profit = (amm.cumulative_fee_realized as i128)
            .checked_add(pnl)
            .unwrap();

        if cum_pnl_profit >= amm.cumulative_fee.checked_div(2).unwrap() as i128 {
            break;
        }

        i = i + 1;
    }

    return new_peg_candidate;
}

pub fn calculate_repeg_candidate_pnl(amm: &AMM, new_peg_candidate: u128) -> i128 {
    let net_user_market_position = (amm.sqrt_k as i128)
        .checked_sub(amm.base_asset_reserve as i128)
        .unwrap();

    let peg_spread_1 = (new_peg_candidate as i128)
        .checked_sub(amm.peg_multiplier as i128)
        .unwrap();

    let peg_spread_direction: i128 = if peg_spread_1 > 0 { 1 } else { -1 };
    let market_position_bias_direction: i128 = if net_user_market_position > 0 { 1 } else { -1 };
    let pnl = (U256::from(
        peg_spread_1
            .unsigned_abs()
            .checked_mul(PRICE_TO_PEG_PRECISION_RATIO)
            .unwrap(),
    )
    .checked_mul(U256::from(net_user_market_position))
    .unwrap()
    .checked_mul(U256::from(amm.base_asset_price_with_mantissa()))
    .unwrap()
    .checked_div(U256::from(MARK_PRICE_MANTISSA))
    .unwrap()
    .checked_div(U256::from(MARK_PRICE_MANTISSA))
    .unwrap()
    .checked_div(U256::from(MARK_PRICE_MANTISSA))
    .unwrap()
    .try_to_u128()
    .unwrap() as i128)
        .checked_mul(
            market_position_bias_direction
                .checked_mul(peg_spread_direction)
                .unwrap(),
        )
        .unwrap();

    return pnl;
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
