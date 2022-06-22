use crate::error::*;
use crate::math::casting::cast_to_i128;

use crate::error::ErrorCode;
use crate::math::amm;
use crate::math::repeg;
use crate::math_error;
use crate::state::market::Market;
use crate::state::oracle::OraclePriceData;
use crate::state::state::OracleGuardRails;
use std::cmp::min;

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

    let (oracle_is_valid, direction_valid, profitability_valid, price_impact_valid) =
        repeg::calculate_repeg_validity_from_oracle_account(
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
        // todo
        // return Err(ErrorCode::InvalidRepegPriceImpact);
        return Err(ErrorCode::InvalidRepegProfitability);
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

pub fn prepeg(
    market: &mut Market,
    mark_price: u128,
    oracle_price_data: &OraclePriceData,
    fee_budget: u128,
    // _now: i64,
) -> ClearingHouseResult<i128> {
    // 0-100
    let curve_update_intensity = cast_to_i128(min(market.amm.curve_update_intensity, 100_u8))?;

    // return early
    if curve_update_intensity == 0 {
        return Ok(0);
    }
    // if !is_oracle_valid {
    //     msg!(
    //         "skipping formulaic_repeg: invalid oracle (oracle delay = {:?})",
    //         oracle_price_data.delay
    //     );
    //     return Ok(0);
    // }

    // let peg_multiplier_before = market.amm.peg_multiplier;
    // let base_asset_reserve_before = market.amm.base_asset_reserve;
    // let quote_asset_reserve_before = market.amm.quote_asset_reserve;
    // let sqrt_k_before = market.amm.sqrt_k;

    // let target_price = cast_to_u128(oracle_price_data.price)?;
    let target_price =
        repeg::calculate_amm_target_price(&market.amm, mark_price, oracle_price_data)?;
    let optimal_peg = repeg::calculate_peg_from_target_price(
        market.amm.quote_asset_reserve,
        market.amm.base_asset_reserve,
        target_price,
    )?;

    msg!(
        "target_price: {:?}, optimal_peg: {:?}",
        target_price,
        optimal_peg
    );
    // assert_eq!(false, true);
    // max budget for single repeg what larger of pool budget and user fee budget
    let repeg_budget = fee_budget;
    //     repeg::calculate_repeg_pool_budget(market, mark_price, oracle_price_data)?;
    // let repeg_budget = min(fee_budget, repeg_pool_budget);
    let (optimal_peg_market, optimal_peg_cost) = repeg::adjust_peg_cost(market, optimal_peg)?;
    // if optimal_peg_cost > 0 && repeg_budget < optimal_peg_cost.unsigned_abs() {
    //     msg!(
    //         "optimal repeg cost {:?} exceeds budget: {:?}",
    //         optimal_peg_cost,
    //         repeg_budget
    //     );
    //     let deficit = optimal_peg_cost
    //         .checked_sub(cast_to_i128(repeg_budget)?)
    //         .ok_or_else(math_error!())?;

    //     // let (k_scale_numerator, k_scale_denominator) =
    //     //     amm::calculate_budgeted_k_scale(market, -deficit, mark_price)?;
    //     let (k_scale_numerator, k_scale_denominator) = (1000, 1000);

    //     // let (k_scale_numerator, k_scale_denominator) = (975, 1000);

    //     // let new_sqrt_k = bn::U192::from(market.amm.sqrt_k)
    //     //     .checked_mul(bn::U192::from(k_scale_numerator))
    //     //     .ok_or_else(math_error!())?
    //     //     .checked_div(bn::U192::from(k_scale_denominator))
    //     //     .ok_or_else(math_error!())?;

    //     // let update_k_result = amm::get_update_k_result(market, new_sqrt_k)?;
    //     // let adjustment_cost = amm::adjust_k_cost(market, &update_k_result)?;
    //     // amm::update_k(market, &update_k_result)?;
    //     let adjustment_cost: i128 = 0;
    //     msg!(
    //         "adjusting k by {:?}/{:?} to save {:?} (but attempted to save: {:?}",
    //         k_scale_numerator,
    //         k_scale_denominator,
    //         adjustment_cost,
    //         deficit
    //     );

    //     assert!(adjustment_cost <= 0);

    //     // let (terminal_price_before, terminal_quote_reserves, _terminal_base_reserves) =
    //     //     amm::calculate_terminal_price_and_reserves(market)?;

    //     let (new_peg_candidate, _prepeg_cost, _repegged_market) = repeg::calculate_budgeted_peg(
    //         market,
    //         market.amm.terminal_quote_asset_reserve,
    //         repeg_budget
    //             .checked_add(adjustment_cost.unsigned_abs())
    //             .ok_or_else(math_error!())?,
    //         // mark_price,
    //         optimal_peg,
    //     )?;
    //     msg!(
    //         "new_peg_candidate {:?} costs {:?}",
    //         new_peg_candidate,
    //         _prepeg_cost,
    //     );
    //     // let (oracle_valid, _direction_valid, profitability_valid, price_impact_valid) =
    //     //     repeg::calculate_repeg_validity(
    //     //         &repegged_market,
    //     //         oracle_price_data,
    //     //         is_oracle_valid,
    //     //         terminal_price_before,
    //     //     )?;
    //     // msg!(
    //     //     "repeg validity: {:?} {:?} {:?}",
    //     //     oracle_valid,
    //     //     profitability_valid,
    //     //     price_impact_valid,
    //     // );
    //     // any budgeted direction valid for formulaic
    //     // if oracle_valid && profitability_valid && price_impact_valid {
    //     let cost_applied = apply_cost_to_market(market, _prepeg_cost)?;
    //     msg!(
    //         "prepeg_cost: {:?} was applied: {:?}",
    //         _prepeg_cost,
    //         cost_applied
    //     );
    //     if cost_applied {
    //         market.amm.peg_multiplier = new_peg_candidate;
    //         // let peg_multiplier_after = market.amm.peg_multiplier;
    //         // let base_asset_reserve_after = market.amm.base_asset_reserve;
    //         // let quote_asset_reserve_after = market.amm.quote_asset_reserve;
    //         // let sqrt_k_after = market.amm.sqrt_k;
    //     }
    //     prepeg_cost = _prepeg_cost;
    //     // }
    // } else {
    market.amm.peg_multiplier = optimal_peg_market.amm.peg_multiplier;
    msg!(
        "optimal repeg cost {:?} below budget: {:?}",
        optimal_peg_cost,
        repeg_budget
    ); // assert_eq!(false, true);
    let prepeg_cost = optimal_peg_cost;
    // }

    Ok(prepeg_cost)
}

pub fn apply_cost_to_market(market: &mut Market, cost: i128) -> ClearingHouseResult<bool> {
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

    // market.amm.net_revenue_since_last_funding = market
    //     .amm
    //     .net_revenue_since_last_funding
    //     .checked_add(cost as i64)
    //     .ok_or_else(math_error!())?;

    Ok(true)
}
