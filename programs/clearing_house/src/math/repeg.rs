use crate::error::*;
use crate::math::bn::U256;
use crate::math::constants::{
    AMM_ASSET_AMOUNT_PRECISION, MARK_PRICE_MANTISSA, PRICE_TO_PEG_PRECISION_RATIO,
    SHARE_OF_FEES_ALLOCATED_TO_REPEG_DENOMINATOR, SHARE_OF_FEES_ALLOCATED_TO_REPEG_NUMERATOR,
    USDC_PRECISION,
};
use crate::math_error;
use crate::state::market::{Market, AMM};
use solana_program::msg;

pub fn calculate_repeg_candidate_pnl(
    market: &Market,
    new_peg_candidate: u128,
) -> ClearingHouseResult<i128> {
    let amm = market.amm;

    let net_user_market_position = market.base_asset_amount;

    let peg_spread_1 = (new_peg_candidate as i128)
        .checked_sub(amm.peg_multiplier as i128)
        .ok_or_else(math_error!())?;

    let peg_spread_direction: i128 = if peg_spread_1 > 0 { 1 } else { -1 };
    let market_position_bias_direction: i128 = if net_user_market_position > 0 { 1 } else { -1 };
    msg!("PNL MAG 1");

    let pnl_mag = U256::from(
        peg_spread_1
            .unsigned_abs()
            .checked_mul(PRICE_TO_PEG_PRECISION_RATIO)
            .ok_or_else(math_error!())?, // 1e10
    )
    .checked_mul(U256::from(net_user_market_position.unsigned_abs())) //1e13
    .ok_or_else(math_error!())?
    .checked_div(U256::from(
        AMM_ASSET_AMOUNT_PRECISION
            .checked_div(USDC_PRECISION)
            .unwrap(), // 1e13/1e6 = 1e7
    ))
    .ok_or_else(math_error!())?;
    msg!("PNL MAG");

    let pnl = (pnl_mag.try_to_u128()? as i128)
        .checked_mul(
            market_position_bias_direction
                .checked_mul(peg_spread_direction)
                .ok_or_else(math_error!())?
                .checked_mul(-1)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    // 1e16 (MANTISSA * USDC_PRECISION)
    return Ok(pnl);
}

pub fn find_valid_repeg(
    market: &Market,
    oracle_px: i128,
    oracle_conf: u128,
) -> ClearingHouseResult<u128> {
    let amm = market.amm;
    let peg_spread_0 = (amm.peg_multiplier as i128)
        .checked_mul(PRICE_TO_PEG_PRECISION_RATIO as i128)
        .ok_or_else(math_error!())?
        .checked_sub(oracle_px)
        .ok_or_else(math_error!())?;

    assert_ne!(peg_spread_0, 0);

    // if peg_spread_0.unsigned_abs().lt(&oracle_conf) {
    //     return Ok(amm.peg_multiplier);
    // }

    let mut i = 1; // max move is half way to oracle
    let mut new_peg_candidate = oracle_px as u128;

    while i < 1000 {
        let base: i128 = 2;
        let step_fraction_size = base.pow(i);
        let step = peg_spread_0
            .checked_div(step_fraction_size)
            .ok_or_else(math_error!())?
            .checked_div(PRICE_TO_PEG_PRECISION_RATIO as i128)
            .ok_or_else(math_error!())?;

        assert_ne!(step, 0);

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

        let pnl = calculate_repeg_candidate_pnl(market, new_peg_candidate)?;
        let pnl_usdc = pnl
            .checked_div(MARK_PRICE_MANTISSA as i128)
            .ok_or_else(math_error!())?;

        msg!(
            "{:?}: new_peg_candidate: {:?}, pnl: {:?}",
            i,
            new_peg_candidate,
            pnl
        );

        if pnl > 0 || pnl_usdc.unsigned_abs() < amm.cumulative_fee_realized {
            let cum_pnl_profit = (amm.cumulative_fee_realized as i128)
                .checked_add(pnl_usdc)
                .ok_or_else(math_error!())?;

            if cum_pnl_profit
                >= amm
                    .cumulative_fee
                    .checked_div(SHARE_OF_FEES_ALLOCATED_TO_REPEG_DENOMINATOR)
                    .ok_or_else(math_error!())? as i128
            {
                break;
            }
        }

        i = i + 1;
    }

    return Ok(new_peg_candidate);
}

// pub fn valid_repeg_profitability(pnl: i128, amm: &AMM) -> bool {
//     return amm.cumulative_fee_realized
//         < amm
//             .cumulative_fee
//             .checked_mul(SHARE_OF_FEES_ALLOCATED_TO_REPEG_NUMERATOR)
//             .ok_or_else(math_error!())?
//             .checked_div(SHARE_OF_FEES_ALLOCATED_TO_REPEG_DENOMINATOR)
//             .ok_or_else(math_error!())?;
// }
