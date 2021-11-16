use crate::error::*;
use crate::math;

use crate::math::constants::{
    PRICE_TO_PEG_PRECISION_RATIO, PRICE_TO_PEG_QUOTE_PRECISION_RATIO,
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

    let (oracle_price, _oracle_twap, oracle_conf, _oracle_twac, _oracle_delay) =
        amm.get_oracle_price(price_oracle, clock_slot)?;
    let current_peg = amm.peg_multiplier;

    // If client passes 0 as the new_peg_candidate, try to find new peg on-chain
    if new_peg_candidate == 0 {
        // try to find semi-opt solution
        new_peg_candidate = math::repeg::find_peg_candidate(&market, oracle_price, oracle_conf)?;
        if new_peg_candidate == amm.peg_multiplier {
            return Err(ErrorCode::InvalidRepegRedundant.into());
        }
    }

    let price_spread_before = cast_to_i128(current_peg)?
        .checked_mul(cast(PRICE_TO_PEG_PRECISION_RATIO)?)
        .ok_or_else(math_error!())?
        .checked_sub(oracle_price)
        .ok_or_else(math_error!())?;
    let price_spread_after = cast_to_i128(new_peg_candidate)?
        .checked_mul(cast(PRICE_TO_PEG_PRECISION_RATIO)?)
        .ok_or_else(math_error!())?
        .checked_sub(oracle_price)
        .ok_or_else(math_error!())?;

    // If the new spread is bigger than the current spread, fail
    // The new peg can only move toward the oracle price
    if price_spread_after.abs() > price_spread_before.abs() {
        return Err(ErrorCode::InvalidRepegDirection.into());
    }

    let mut total_fee_minus_distributions = amm.total_fee_minus_distributions;
    let net_market_position = market.base_asset_amount;

    let repeg_pnl = math::repeg::calculate_repeg_pnl(market, new_peg_candidate)?;
    // Reduce pnl to quote asset precision and take the absolute value
    let repeg_pnl_quote_precision = repeg_pnl
        .unsigned_abs()
        .checked_div(PRICE_TO_PEG_QUOTE_PRECISION_RATIO)
        .ok_or_else(math_error!())?;

    // The there is a net market position, there should be a non-zero pnl
    // If pnl is zero, fail
    if net_market_position != 0 && repeg_pnl == 0 {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    }

    // If reducing precision to quote asset leads to zero pnl, fail
    if repeg_pnl < 0 && repeg_pnl_quote_precision == 0 {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    }

    if repeg_pnl >= 0 {
        total_fee_minus_distributions = total_fee_minus_distributions
            .checked_add(repeg_pnl_quote_precision)
            .ok_or_else(math_error!())?;
    } else {
        total_fee_minus_distributions = (total_fee_minus_distributions)
            .checked_sub(repeg_pnl_quote_precision)
            .or(Some(0))
            .unwrap();

        // Only a portion of the protocol fees are allocated to repegging
        // This checks that the total_fee_minus_distributions does not decrease too much after repeg
        if total_fee_minus_distributions
            < amm
                .total_fee
                .checked_mul(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR)
                .ok_or_else(math_error!())?
                .checked_div(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR)
                .ok_or_else(math_error!())?
        {
            return Err(ErrorCode::InvalidRepegProfitability.into());
        }
    }

    market.amm.total_fee_minus_distributions = total_fee_minus_distributions;
    market.amm.peg_multiplier = new_peg_candidate;

    let repeg_pnl_quote_precision_signed = if repeg_pnl > 0 {
        cast_to_i128(repeg_pnl_quote_precision)?
    } else {
        cast_to_i128(repeg_pnl_quote_precision)?
            .checked_mul(-1)
            .ok_or_else(math_error!())?
    };

    Ok(repeg_pnl_quote_precision_signed)
}
