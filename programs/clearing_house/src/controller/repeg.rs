use crate::controller;
use crate::error::*;
use crate::math;
use crate::math::constants::{
    FUNDING_PAYMENT_MANTISSA, PRICE_TO_PEG_PRECISION_RATIO, SHARE_OF_FEES_ALLOCATED_TO_REPEG,
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

    let current_mark = amm.base_asset_price_with_mantissa()?;

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
    //todo: replace with Market.base_asset_amount
    let base_asset_amount_i = amm.sqrt_k as i128;
    let net_market_position = base_asset_amount_i
        .checked_sub(amm.base_asset_reserve as i128)
        .ok_or_else(math_error!())?;

    let pnl = math::repeg::calculate_repeg_candidate_pnl(amm, new_peg_candidate)?;

    if net_market_position != 0 && pnl == 0 {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    }

    if pnl >= 0 {
        pnl_r = pnl_r
            .checked_add(pnl.unsigned_abs())
            .ok_or_else(math_error!())?;
    } else if pnl.abs() as u128 > pnl_r {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    } else {
        pnl_r = (pnl_r)
            .checked_sub(pnl.unsigned_abs())
            .ok_or_else(math_error!())?;
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
                let repeg_profit_per_unit = pnl
                    .unsigned_abs()
                    .checked_mul(FUNDING_PAYMENT_MANTISSA)
                    .ok_or_else(math_error!())?
                    .checked_div(market.base_asset_amount_short.unsigned_abs())
                    .ok_or_else(math_error!())?;

                amm.cumulative_repeg_rebate_short = amm
                    .cumulative_repeg_rebate_short
                    .checked_add(repeg_profit_per_unit)
                    .ok_or_else(math_error!())?;
            }
        } else {
            if market.base_asset_amount_long.unsigned_abs() > 0 {
                let repeg_profit_per_unit = pnl
                    .unsigned_abs()
                    .checked_mul(FUNDING_PAYMENT_MANTISSA)
                    .ok_or_else(math_error!())?
                    .checked_div(market.base_asset_amount_long.unsigned_abs())
                    .ok_or_else(math_error!())?;

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
