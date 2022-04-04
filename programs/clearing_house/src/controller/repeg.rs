use crate::error::*;
use crate::math::casting::cast_to_u128;
use std::cell::RefMut;

use crate::math::repeg;

use crate::math::amm;
use crate::math_error;
use crate::state::market::{Market, OraclePriceData};
use crate::state::state::OracleGuardRails;
use std::cmp::min;

use crate::state::history::curve::{ExtendedCurveHistory, ExtendedCurveRecord};
use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

pub fn repeg(
    market: &mut Market,
    price_oracle: &AccountInfo,
    new_peg_candidate: u128,
    clock_slot: u64,
    oracle_guard_rails: &OracleGuardRails,
) -> ClearingHouseResult<i128> {
    // for adhoc admin only repeg

    if new_peg_candidate == market.amm.peg_multiplier {
        return Err(ErrorCode::InvalidRepegRedundant);
    }
    let (terminal_price_before, _terminal_quote_reserves, _terminal_base_reserves) =
        amm::calculate_terminal_price_and_reserves(market)?;

    let (repegged_market, adjustment_cost) = repeg::adjust_peg_cost(market, new_peg_candidate)?;

    let (
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        _oracle_terminal_divergence,
    ) = repeg::calculate_repeg_validity_from_oracle_account(
        &repegged_market,
        price_oracle,
        terminal_price_before,
        clock_slot,
        oracle_guard_rails,
    )?;

    // cannot repeg if oracle is invalid
    if !oracle_is_valid {
        return Err(ErrorCode::InvalidOracle);
    }

    // only push terminal in direction of oracle
    if !direction_valid {
        return Err(ErrorCode::InvalidRepegDirection);
    }

    // only push terminal up to closer edge of oracle confidence band
    if !profitability_valid {
        return Err(ErrorCode::InvalidRepegProfitability);
    }

    // only push mark up to further edge of oracle confidence band
    if !price_impact_valid {
        return Err(ErrorCode::InvalidRepegPriceImpact);
    }

    // modify market's total fee change and peg change
    let cost_applied = apply_cost_to_market(market, adjustment_cost)?;
    if cost_applied {
        market.amm.peg_multiplier = new_peg_candidate;
    } else {
        return Err(ErrorCode::InvalidRepegProfitability);
    }

    Ok(adjustment_cost)
}

pub fn formulaic_repeg(
    market: &mut Market,
    mark_price: u128,
    oracle_price_data: &OraclePriceData,
    is_oracle_valid: bool,
    fee_budget: u128,
    curve_history: &mut RefMut<ExtendedCurveHistory>,
    now: i64,
    market_index: u64,
    trade_record: u128,
) -> ClearingHouseResult<i128> {
    // backrun market swaps to do automatic on-chain repeg

    if !is_oracle_valid || oracle_price_data.delay > 5 {
        msg!(
            "invalid oracle (oracle delay = {:?})",
            oracle_price_data.delay
        );
        return Ok(0);
    }

    let peg_multiplier_before = market.amm.peg_multiplier;
    let base_asset_reserve_before = market.amm.base_asset_reserve;
    let quote_asset_reserve_before = market.amm.quote_asset_reserve;
    let sqrt_k_before = market.amm.sqrt_k;

    let (terminal_price_before, terminal_quote_reserves, _terminal_base_reserves) =
        amm::calculate_terminal_price_and_reserves(market)?;

    // max budget for single repeg what larger of pool budget and user fee budget
    let repeg_pool_budget =
        repeg::calculate_repeg_pool_budget(market, mark_price, oracle_price_data)?;
    let repeg_budget = min(fee_budget, repeg_pool_budget);

    let (new_peg_candidate, adjustment_cost, repegged_market) = repeg::calculate_budgeted_peg(
        market,
        terminal_quote_reserves,
        repeg_budget,
        mark_price,
        cast_to_u128(oracle_price_data.price)?,
    )?;

    let (
        oracle_valid,
        _direction_valid,
        profitability_valid,
        price_impact_valid,
        _oracle_terminal_divergence_pct_after,
    ) = repeg::calculate_repeg_validity(
        &repegged_market,
        oracle_price_data,
        is_oracle_valid,
        terminal_price_before,
    )?;

    // any budgeted direction valid for formulaic
    if oracle_valid && profitability_valid && price_impact_valid {
        let cost_applied = apply_cost_to_market(market, adjustment_cost)?;
        if cost_applied {
            market.amm.peg_multiplier = new_peg_candidate;

            let peg_multiplier_after = market.amm.peg_multiplier;
            let base_asset_reserve_after = market.amm.base_asset_reserve;
            let quote_asset_reserve_after = market.amm.quote_asset_reserve;
            let sqrt_k_after = market.amm.sqrt_k;

            let record_id = curve_history.next_record_id();
            curve_history.append(ExtendedCurveRecord {
                ts: now,
                record_id,
                market_index,
                peg_multiplier_before,
                base_asset_reserve_before,
                quote_asset_reserve_before,
                sqrt_k_before,
                peg_multiplier_after,
                base_asset_reserve_after,
                quote_asset_reserve_after,
                sqrt_k_after,
                base_asset_amount_long: market.base_asset_amount_long.unsigned_abs(),
                base_asset_amount_short: market.base_asset_amount_short.unsigned_abs(),
                base_asset_amount: market.base_asset_amount,
                open_interest: market.open_interest,
                total_fee: market.amm.total_fee,
                total_fee_minus_distributions: market.amm.total_fee_minus_distributions,
                adjustment_cost,
                oracle_price: oracle_price_data.price,
                trade_record,
                padding: [0; 5],
            });
        }
    }

    Ok(adjustment_cost)
}

fn apply_cost_to_market(market: &mut Market, cost: i128) -> ClearingHouseResult<bool> {
    // positive cost is expense, negative cost is revenue
    // Reduce pnl to quote asset precision and take the absolute value
    if cost > 0 {
        let new_total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_sub(cost.unsigned_abs())
            .ok_or_else(math_error!())?;

        // Only a portion of the protocol fees are allocated to repegging
        // This checks that the total_fee_minus_distributions does not decrease too much after repeg
        if new_total_fee_minus_distributions > repeg::total_fee_lower_bound(market)? {
            market.amm.total_fee_minus_distributions = new_total_fee_minus_distributions;
        } else {
            return Ok(false);
        }
    } else {
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(cost.unsigned_abs())
            .ok_or_else(math_error!())?;
    }

    market.amm.net_revenue_since_last_funding = market
        .amm
        .net_revenue_since_last_funding
        .checked_add(cost as i64)
        .ok_or_else(math_error!())?;

    Ok(true)
}
