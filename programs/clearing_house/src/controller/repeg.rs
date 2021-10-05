use crate::controller;
use crate::error::*;
use crate::math;
use crate::math::bn;

use crate::math::constants::{
    AMM_ASSET_AMOUNT_PRECISION, FUNDING_PAYMENT_MANTISSA, MARK_PRICE_MANTISSA,
    PRICE_TO_PEG_PRECISION_RATIO, SHARE_OF_FEES_ALLOCATED_TO_REPEG,
};
use crate::math_error;
use crate::state::market::Market;
use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

pub fn repeg(
    market: &mut Market,
    price_oracle: &AccountInfo,
    new_peg_candidate: u128,
) -> ClearingHouseResult {
    let amm = &mut market.amm;
    if new_peg_candidate == amm.peg_multiplier {
        return Err(ErrorCode::InvalidRepegRedundant.into());
    }

    let mut new_peg_candidate = new_peg_candidate;

    let (oracle_px, oracle_conf) = amm.get_oracle_price(price_oracle, 0)?;
    let cur_peg = amm.peg_multiplier;

    let current_mark = amm.mark_price()?;

    if new_peg_candidate == 0 {
        // try to find semi-opt solution
        new_peg_candidate = math::repeg::find_valid_repeg(&amm, oracle_px, oracle_conf)?;
        if new_peg_candidate == amm.peg_multiplier {
            return Err(ErrorCode::InvalidRepegRedundant.into());
        }
    }

    let price_spread_0 = (cur_peg as i128)
        .checked_mul(PRICE_TO_PEG_PRECISION_RATIO as i128)
        .ok_or_else(math_error!())?
        .checked_sub(oracle_px)
        .ok_or_else(math_error!())?;
    let price_spread_1 = (new_peg_candidate as i128)
        .checked_mul(PRICE_TO_PEG_PRECISION_RATIO as i128)
        .ok_or_else(math_error!())?
        .checked_sub(oracle_px)
        .ok_or_else(math_error!())?;

    if price_spread_1.abs() > price_spread_0.abs() {
        // decrease
        return Err(ErrorCode::InvalidRepegDirection.into());
    }

    let mut pnl_r = amm.cumulative_fee_realized;
    let net_market_position = market.base_asset_amount;

    let pnl_mantissa = math::repeg::calculate_repeg_candidate_pnl(amm, new_peg_candidate)?;
    let pnl_mag = pnl_mantissa
        .unsigned_abs()
        .checked_div(MARK_PRICE_MANTISSA)
        .ok_or_else(math_error!())?;

    if net_market_position != 0 && pnl_mantissa == 0 {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    }

    if pnl_mantissa != 0 && pnl_mag == 0 {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    }

    if net_market_position != 0 && pnl_mag == 0 {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    }

    if pnl_mantissa >= 0 {
        pnl_r = pnl_r.checked_add(pnl_mag).ok_or_else(math_error!())?;
    } else if pnl_mag > pnl_r {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    } else {
        pnl_r = (pnl_r).checked_sub(pnl_mag).ok_or_else(math_error!())?;
        if pnl_r
            < amm
                .cumulative_fee
                .checked_div(SHARE_OF_FEES_ALLOCATED_TO_REPEG)
                .ok_or_else(math_error!())?
        {
            return Err(ErrorCode::InvalidRepegProfitability.into());
        }

        // profit sharing with only those who held the rewarded position before repeg
        if new_peg_candidate < amm.peg_multiplier {
            if market.base_asset_amount_short.unsigned_abs() > 0 {
                let repeg_profit_per_unit = bn::U256::from(pnl_mantissa.unsigned_abs())
                    .checked_mul(bn::U256::from(AMM_ASSET_AMOUNT_PRECISION))
                    .ok_or_else(math_error!())?
                    .checked_div(bn::U256::from(
                        market.base_asset_amount_short.unsigned_abs(),
                    ))
                    .ok_or_else(math_error!())?
                    .try_to_u128()?;

                amm.cumulative_repeg_rebate_short = amm
                    .cumulative_repeg_rebate_short
                    .checked_add(repeg_profit_per_unit)
                    .ok_or_else(math_error!())?;
            }
        } else {
            if market.base_asset_amount_long.unsigned_abs() > 0 {
                let repeg_profit_per_unit = bn::U256::from(pnl_mantissa.unsigned_abs())
                    .checked_mul(bn::U256::from(AMM_ASSET_AMOUNT_PRECISION))
                    .ok_or_else(math_error!())?
                    .checked_div(bn::U256::from(market.base_asset_amount_long.unsigned_abs()))
                    .ok_or_else(math_error!())?
                    .try_to_u128()?;

                amm.cumulative_repeg_rebate_long = amm
                    .cumulative_repeg_rebate_long
                    .checked_add(repeg_profit_per_unit)
                    .ok_or_else(math_error!())?;
            }
        }

        controller::amm::move_to_price(amm, current_mark)?;
    }

    amm.cumulative_fee_realized = pnl_r;
    amm.peg_multiplier = new_peg_candidate;

    Ok(())
}
