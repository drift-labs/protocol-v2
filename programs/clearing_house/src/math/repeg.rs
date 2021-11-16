use crate::error::*;
use crate::math::bn::U256;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128};
use crate::math::constants::{
    AMM_RESERVE_PRECISION, PRICE_TO_PEG_PRECISION_RATIO, PRICE_TO_PEG_QUOTE_PRECISION_RATIO,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR,
};
use crate::math_error;
use crate::state::market::Market;
use solana_program::msg;

pub fn find_peg_candidate(
    market: &Market,
    oracle_px: i128,
    _oracle_conf: u128,
) -> ClearingHouseResult<u128> {
    let amm = market.amm;
    let peg_spread_before = cast_to_i128(amm.peg_multiplier)?
        .checked_mul(cast(PRICE_TO_PEG_PRECISION_RATIO)?)
        .ok_or_else(math_error!())?
        .checked_sub(oracle_px)
        .ok_or_else(math_error!())?;

    assert_ne!(peg_spread_before, 0);

    let mut i = 1;
    let mut new_peg_candidate = cast_to_u128(oracle_px)?;

    while i < 1000 {
        let base: i128 = 2;
        // max move is half way to oracle
        let step_fraction_size = base.pow(i);
        let step = peg_spread_before
            .checked_div(step_fraction_size)
            .ok_or_else(math_error!())?
            .checked_div(cast(PRICE_TO_PEG_PRECISION_RATIO)?)
            .ok_or_else(math_error!())?;

        assert_ne!(step, 0);

        if peg_spread_before < 0 {
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

        let repeg_pnl = calculate_repeg_pnl(market, new_peg_candidate)?;
        let repeg_pnl_quote_precision = repeg_pnl
            .checked_div(cast(PRICE_TO_PEG_QUOTE_PRECISION_RATIO)?)
            .ok_or_else(math_error!())?;

        if repeg_pnl > 0
            || repeg_pnl_quote_precision.unsigned_abs() < amm.total_fee_minus_distributions
        {
            let total_fee_minus_distributions = cast_to_i128(amm.total_fee_minus_distributions)?
                .checked_add(repeg_pnl_quote_precision)
                .ok_or_else(math_error!())?;

            // if the new peg candidate respects the protocols fee budget, we've found a valid peg candidate
            if total_fee_minus_distributions
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

pub fn calculate_repeg_pnl(market: &Market, new_peg_candidate: u128) -> ClearingHouseResult<i128> {
    let amm = market.amm;

    let net_market_position = market.base_asset_amount;

    let peg_spread = cast_to_i128(new_peg_candidate)?
        .checked_sub(cast(amm.peg_multiplier)?)
        .ok_or_else(math_error!())?;

    let peg_spread_direction: i128 = if peg_spread > 0 { 1 } else { -1 };
    let market_position_bias_direction: i128 = if net_market_position > 0 { 1 } else { -1 };

    // The pnl is equal to peg_spread * net_market_position * -1
    // If the net_market_position is long (>0) and the peg increases (peg_spread > 0),
    // then the pnl for the clearing house is negative because the net longs get a better price when they close
    // If the net market is long (>0) and the peg decreases (peg_spread < 0),
    // then the pnl for the clearing house is positive because the net longs get a worse price when they close
    let pnl_magnitude = U256::from(
        peg_spread
            .unsigned_abs()
            .checked_mul(PRICE_TO_PEG_PRECISION_RATIO)
            .ok_or_else(math_error!())?, // 1e10
    )
    .checked_mul(U256::from(net_market_position.unsigned_abs())) //1e13
    .ok_or_else(math_error!())?
    .checked_div(U256::from(
        AMM_RESERVE_PRECISION, // 1e13
    ))
    .ok_or_else(math_error!())?;

    let pnl = cast_to_i128(pnl_magnitude.try_to_u128()?)?
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
