use crate::math::bn::U256;
use crate::math::constants::{MARK_PRICE_MANTISSA, PRICE_TO_PEG_PRECISION_RATIO};
use crate::state::market::AMM;

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
