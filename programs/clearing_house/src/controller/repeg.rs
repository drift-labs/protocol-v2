use crate::controller;
use crate::error::*;
use crate::math;

use crate::math::constants::{
    MARK_PRICE_PRECISION, PRICE_TO_PEG_PRECISION_RATIO, QUOTE_PRECISION,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR,
};
use crate::math_error;
use crate::state::market::Market;

use crate::math::casting::{cast, cast_to_i128};
use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

pub fn repeg(
    market: &mut Market,
    price_oracle: &AccountInfo,
    new_peg_candidate: u128,
    clock_slot: u64,
) -> ClearingHouseResult<i128> {
    let amm = market.amm;
    if new_peg_candidate == amm.peg_multiplier {
        return Err(ErrorCode::InvalidRepegRedundant.into());
    }

    let mut new_peg_candidate = new_peg_candidate;

    let (oracle_px, _oracle_twap, oracle_conf, _oracle_twac, _oracle_delay) =
        amm.get_oracle_price(price_oracle, clock_slot)?;
    let cur_peg = amm.peg_multiplier;

    let current_mark = amm.mark_price()?;
    let perserve_price;

    if new_peg_candidate == 0 {
        // try to find semi-opt solution
        new_peg_candidate = math::repeg::find_valid_repeg(&market, oracle_px, oracle_conf)?;
        if new_peg_candidate == amm.peg_multiplier {
            return Err(ErrorCode::InvalidRepegRedundant.into());
        }
    }

    let price_spread_0 = cast_to_i128(cur_peg)?
        .checked_mul(cast(PRICE_TO_PEG_PRECISION_RATIO)?)
        .ok_or_else(math_error!())?
        .checked_sub(oracle_px)
        .ok_or_else(math_error!())?;
    let price_spread_1 = cast_to_i128(new_peg_candidate)?
        .checked_mul(cast(PRICE_TO_PEG_PRECISION_RATIO)?)
        .ok_or_else(math_error!())?
        .checked_sub(oracle_px)
        .ok_or_else(math_error!())?;

    if price_spread_1.abs() > price_spread_0.abs() {
        // decrease
        return Err(ErrorCode::InvalidRepegDirection.into());
    }

    let mut pnl_r = amm.total_fee_minus_distributions;
    let net_market_position = market.base_asset_amount;

    let amm_pnl = math::repeg::calculate_repeg_candidate_pnl(market, new_peg_candidate)?;
    let amm_pnl_quote_precision = amm_pnl
        .unsigned_abs()
        .checked_div(
            MARK_PRICE_PRECISION
                .checked_div(QUOTE_PRECISION)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    if net_market_position != 0 && amm_pnl == 0 {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    }

    if amm_pnl < 0 && amm_pnl_quote_precision == 0 {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    }

    if amm_pnl >= 0 {
        pnl_r = pnl_r
            .checked_add(amm_pnl_quote_precision)
            .ok_or_else(math_error!())?;

        perserve_price = false;
    } else if amm_pnl_quote_precision > pnl_r {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    } else {
        pnl_r = (pnl_r)
            .checked_sub(amm_pnl_quote_precision)
            .ok_or_else(math_error!())?;
        if pnl_r
            < amm
                .total_fee
                .checked_mul(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR)
                .ok_or_else(math_error!())?
                .checked_div(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR)
                .ok_or_else(math_error!())?
        {
            return Err(ErrorCode::InvalidRepegProfitability.into());
        }

        perserve_price = false;
    }

    market.amm.total_fee_minus_distributions = pnl_r;
    market.amm.peg_multiplier = new_peg_candidate;

    if perserve_price {
        controller::amm::move_to_price(&mut market.amm, current_mark)?;
    }

    let amm_pnl_quote_asset_signed = if amm_pnl > 0 {
        cast_to_i128(amm_pnl_quote_precision)?
    } else {
        cast_to_i128(amm_pnl_quote_precision)?
            .checked_mul(-1)
            .ok_or_else(math_error!())?
    };

    Ok(amm_pnl_quote_asset_signed)
}
