use crate::error::*;
use crate::math::bn::U256;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128};
use crate::math::constants::{
    AMM_RESERVE_PRECISION, MARK_PRICE_PRECISION, PRICE_TO_PEG_PRECISION_RATIO, QUOTE_PRECISION,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR,
};
use crate::math_error;
use crate::state::market::Market;
use solana_program::msg;

pub fn calculate_repeg_candidate_pnl(
    market: &Market,
    new_peg_candidate: u128,
) -> ClearingHouseResult<i128> {
    let amm = market.amm;

    let net_user_market_position = market.base_asset_amount;

    let peg_spread_1 = cast_to_i128(new_peg_candidate)?
        .checked_sub(cast(amm.peg_multiplier)?)
        .ok_or_else(math_error!())?;

    let peg_spread_direction: i128 = if peg_spread_1 > 0 { 1 } else { -1 };
    let market_position_bias_direction: i128 = if net_user_market_position > 0 { 1 } else { -1 };

    let pnl_mag = U256::from(
        peg_spread_1
            .unsigned_abs()
            .checked_mul(PRICE_TO_PEG_PRECISION_RATIO)
            .ok_or_else(math_error!())?, // 1e10
    )
    .checked_mul(U256::from(net_user_market_position.unsigned_abs())) //1e13
    .ok_or_else(math_error!())?
    .checked_div(U256::from(
        AMM_RESERVE_PRECISION, // 1e13
    ))
    .ok_or_else(math_error!())?;

    let pnl = cast_to_i128(pnl_mag.try_to_u128()?)?
        .checked_mul(
            market_position_bias_direction
                .checked_mul(peg_spread_direction)
                .ok_or_else(math_error!())?
                .checked_mul(-1)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    // 1e10 (PRECISION)
    return Ok(pnl);
}

pub fn find_valid_repeg(
    market: &Market,
    oracle_px: i128,
    _oracle_conf: u128,
) -> ClearingHouseResult<u128> {
    let amm = market.amm;
    let peg_spread_0 = cast_to_i128(amm.peg_multiplier)?
        .checked_mul(cast(PRICE_TO_PEG_PRECISION_RATIO)?)
        .ok_or_else(math_error!())?
        .checked_sub(oracle_px)
        .ok_or_else(math_error!())?;

    assert_ne!(peg_spread_0, 0);

    // if peg_spread_0.unsigned_abs().lt(&oracle_conf) {
    //     return Ok(amm.peg_multiplier);
    // }

    let mut i = 1; // max move is half way to oracle
    let mut new_peg_candidate = cast_to_u128(oracle_px)?;

    while i < 1000 {
        let base: i128 = 2;
        let step_fraction_size = base.pow(i);
        let step = peg_spread_0
            .checked_div(step_fraction_size)
            .ok_or_else(math_error!())?
            .checked_div(cast(PRICE_TO_PEG_PRECISION_RATIO)?)
            .ok_or_else(math_error!())?;

        assert_ne!(step, 0);

        if peg_spread_0 < 0 {
            new_peg_candidate = amm
                .peg_multiplier
                .checked_add(cast(step.abs())?)
                .ok_or_else(math_error!())?;
        } else {
            new_peg_candidate = amm
                .peg_multiplier
                .checked_sub(cast(step.abs())?)
                .ok_or_else(math_error!())?;
        }

        let pnl = calculate_repeg_candidate_pnl(market, new_peg_candidate)?;
        let pnl_quote_precision = pnl
            .checked_div(cast(
                MARK_PRICE_PRECISION
                    .checked_div(QUOTE_PRECISION)
                    .ok_or_else(math_error!())?,
            )?)
            .ok_or_else(math_error!())?;

        if pnl > 0 || pnl_quote_precision.unsigned_abs() < amm.total_fee_minus_distributions {
            let cum_pnl_profit = cast_to_i128(amm.total_fee_minus_distributions)?
                .checked_add(pnl_quote_precision)
                .ok_or_else(math_error!())?;

            if cum_pnl_profit
                >= cast_to_i128(
                    amm.total_fee
                        .checked_mul(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR)
                        .ok_or_else(math_error!())?
                        .checked_div(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR)
                        .ok_or_else(math_error!())?,
                )?
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
