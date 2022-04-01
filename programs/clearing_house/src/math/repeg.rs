use crate::error::*;
use crate::math::amm;
use crate::math::bn;
use crate::math::casting::{cast_to_i128, cast_to_u128};
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO, FUNDING_EXCESS_TO_QUOTE_RATIO, MARK_PRICE_PRECISION, ONE_HOUR,
    PEG_PRECISION, PRICE_SPREAD_PRECISION, PRICE_TO_PEG_PRECISION_RATIO, QUOTE_PRECISION,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR, TWENTYFOUR_HOUR,
};
use crate::math::position::_calculate_base_asset_value_and_pnl;
use crate::math_error;
use crate::state::market::{Market, OraclePriceData};
use std::cmp::{max, min};

use crate::state::state::OracleGuardRails;
use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

pub fn calculate_repeg_validity_from_oracle_account(
    market: &Market,
    oracle_account_info: &AccountInfo,
    terminal_price_before: u128,
    clock_slot: u64,
    oracle_guard_rails: &OracleGuardRails,
) -> ClearingHouseResult<(bool, bool, bool, bool, i128)> {
    let oracle_price_data = market
        .amm
        .get_oracle_price(oracle_account_info, clock_slot)?;
    let oracle_is_valid = amm::is_oracle_valid(
        &market.amm,
        &oracle_price_data,
        &oracle_guard_rails.validity,
    )?;

    let (
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        oracle_terminal_divergence_pct_after,
    ) = calculate_repeg_validity(
        market,
        &oracle_price_data,
        oracle_is_valid,
        terminal_price_before,
    )?;

    Ok((
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        oracle_terminal_divergence_pct_after,
    ))
}

pub fn calculate_repeg_validity(
    market: &Market,
    oracle_price_data: &OraclePriceData,
    oracle_is_valid: bool,
    terminal_price_before: u128,
) -> ClearingHouseResult<(bool, bool, bool, bool, i128)> {
    let OraclePriceData {
        price: oracle_price,
        confidence: oracle_conf,
        delay: _,
        has_sufficient_number_of_data_points: _,
    } = *oracle_price_data;

    let oracle_price_u128 = cast_to_u128(oracle_price)?;

    let (terminal_price_after, _terminal_quote_reserves, _terminal_base_reserves) =
        amm::calculate_terminal_price_and_reserves(market)?;
    let oracle_terminal_spread_after = oracle_price
        .checked_sub(cast_to_i128(terminal_price_after)?)
        .ok_or_else(math_error!())?;
    let oracle_terminal_divergence_pct_after = oracle_terminal_spread_after
        .checked_mul(PRICE_SPREAD_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(oracle_price)
        .ok_or_else(math_error!())?;

    let mut direction_valid = true;
    let mut price_impact_valid = true;
    let mut profitability_valid = true;

    // if oracle is valid: check on size/direction of repeg
    if oracle_is_valid {
        let mark_price_after = amm::calculate_price(
            market.amm.quote_asset_reserve,
            market.amm.base_asset_reserve,
            market.amm.peg_multiplier,
        )?;

        let oracle_conf_band_top = oracle_price_u128
            .checked_add(oracle_conf)
            .ok_or_else(math_error!())?;

        let oracle_conf_band_bottom = oracle_price_u128
            .checked_sub(oracle_conf)
            .ok_or_else(math_error!())?;

        #[allow(clippy::comparison_chain)]
        if oracle_price_u128 > terminal_price_after {
            // only allow terminal up when oracle is higher
            if terminal_price_after < terminal_price_before {
                msg!(
                    "oracle: {:?}, termb: {:?}, terma: {:?},",
                    oracle_price_u128,
                    terminal_price_before,
                    terminal_price_after
                );
                direction_valid = false;
            }

            // only push terminal up to bottom of oracle confidence band
            if oracle_conf_band_bottom < terminal_price_after {
                profitability_valid = false;
            }

            // only push mark up to top of oracle confidence band
            if mark_price_after > oracle_conf_band_top {
                price_impact_valid = false;
            }
        } else if oracle_price_u128 < terminal_price_after {
            // only allow terminal down when oracle is lower
            if terminal_price_after > terminal_price_before {
                msg!(
                    "oracle: {:?}, termb: {:?}, terma: {:?},",
                    oracle_price_u128,
                    terminal_price_before,
                    terminal_price_after
                );
                direction_valid = false;
            }

            // only push terminal down to top of oracle confidence band
            if oracle_conf_band_top > terminal_price_after {
                profitability_valid = false;
            }

            // only push mark down to bottom of oracle confidence band
            if mark_price_after < oracle_conf_band_bottom {
                price_impact_valid = false;
            }
        }
    } else {
        direction_valid = false;
        price_impact_valid = false;
        profitability_valid = false;
    }

    Ok((
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        oracle_terminal_divergence_pct_after,
    ))
}

pub fn calculate_peg_from_target_price(
    quote_asset_reserve: u128,
    base_asset_reserve: u128,
    target_price: u128,
) -> ClearingHouseResult<u128> {
    let new_peg = bn::U192::from(target_price)
        .checked_mul(bn::U192::from(base_asset_reserve))
        .ok_or_else(math_error!())?
        .checked_div(bn::U192::from(quote_asset_reserve))
        .ok_or_else(math_error!())?
        .checked_div(bn::U192::from(PRICE_TO_PEG_PRECISION_RATIO))
        .ok_or_else(math_error!())?
        .try_to_u128()?;
    Ok(new_peg)
}

pub fn calculate_budgeted_peg(
    market: &mut Market,
    terminal_quote_reserves: u128,
    budget: u128,
    current_price: u128,
    target_price: u128,
) -> ClearingHouseResult<(u128, i128, Market)> {
    // calculates peg_multiplier that changing to would cost no more than budget

    let optimal_peg = calculate_peg_from_target_price(
        market.amm.quote_asset_reserve,
        market.amm.base_asset_reserve,
        target_price
            .checked_add(current_price)
            .ok_or_else(math_error!())?
            .checked_div(2)
            .ok_or_else(math_error!())?,
    )?;

    let delta_peg_sign = if market.amm.quote_asset_reserve > terminal_quote_reserves {
        1
    } else {
        -1
    };

    let optimal_peg_sign = if optimal_peg > market.amm.peg_multiplier {
        1
    } else {
        -1
    };

    // use optimal peg when cost <=0
    let use_optimal_peg = market.amm.quote_asset_reserve == terminal_quote_reserves
        || delta_peg_sign != optimal_peg_sign;

    let full_budget_peg: u128 = if use_optimal_peg {
        optimal_peg
    } else {
        let delta_quote_asset_reserves = if delta_peg_sign > 0 {
            market
                .amm
                .quote_asset_reserve
                .checked_sub(terminal_quote_reserves)
                .ok_or_else(math_error!())?
        } else {
            terminal_quote_reserves
                .checked_sub(market.amm.quote_asset_reserve)
                .ok_or_else(math_error!())?
        };

        let delta_peg_multiplier = budget
            .checked_mul(MARK_PRICE_PRECISION)
            .ok_or_else(math_error!())?
            .checked_div(
                delta_quote_asset_reserves
                    .checked_div(AMM_TO_QUOTE_PRECISION_RATIO)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?;

        let delta_peg_precision = delta_peg_multiplier
            .checked_div(MARK_PRICE_PRECISION / PEG_PRECISION)
            .ok_or_else(math_error!())?;

        let new_budget_peg = if delta_peg_sign > 0 {
            market
                .amm
                .peg_multiplier
                .checked_add(delta_peg_precision)
                .ok_or_else(math_error!())?
        } else {
            market
                .amm
                .peg_multiplier
                .checked_sub(delta_peg_precision)
                .ok_or_else(math_error!())?
        };
        new_budget_peg
    };

    // avoid overshooting past target price w/ budget
    let candidate_peg: u128 = if (current_price > target_price && full_budget_peg < optimal_peg)
        || (current_price < target_price && full_budget_peg > optimal_peg)
    {
        optimal_peg
    } else {
        full_budget_peg
    };

    let (repegged_market, candidate_cost) = adjust_peg_cost(market, candidate_peg)?;

    Ok((candidate_peg, candidate_cost, repegged_market))
}

pub fn adjust_peg_cost(
    market: &Market,
    new_peg_candidate: u128,
) -> ClearingHouseResult<(Market, i128)> {
    let mut market_clone = *market;

    let cost = if new_peg_candidate != market_clone.amm.peg_multiplier {
        // Find the net market value before adjusting peg
        let (current_net_market_value, _) = _calculate_base_asset_value_and_pnl(
            market_clone.base_asset_amount,
            0,
            &market_clone.amm,
        )?;

        market_clone.amm.peg_multiplier = new_peg_candidate;

        let (_new_net_market_value, cost) = _calculate_base_asset_value_and_pnl(
            market_clone.base_asset_amount,
            current_net_market_value,
            &market_clone.amm,
        )?;
        cost
    } else {
        0_i128
    };

    Ok((market_clone, cost))
}

pub fn calculate_repeg_pool_budget(
    market: &Market,
    mark_price: u128,
    oracle_price_data: &OraclePriceData,
) -> ClearingHouseResult<u128> {
    let fee_pool = calculate_fee_pool(market)?;
    let expected_excess_funding_payment =
        calculate_expected_excess_funding_payment(market, oracle_price_data.price, mark_price)?;

    // for a single repeg, utilize the lesser of:
    // 1) 1 QUOTE (for soft launch)
    // 2) 1/10th the expected_excess_funding_payment
    // 3) 1/100th of the fee pool (for funding/repeg)

    let max_budget_quote = QUOTE_PRECISION;
    let pool_budget = min(
        max_budget_quote,
        min(
            cast_to_u128(max(0, expected_excess_funding_payment))?
                .checked_div(10)
                .ok_or_else(math_error!())?,
            fee_pool.checked_div(100).ok_or_else(math_error!())?,
        ),
    );

    Ok(pool_budget)
}

pub fn calculate_expected_excess_funding_payment(
    market: &Market,
    oracle_price: i128,
    mark_price: u128,
) -> ClearingHouseResult<i128> {
    let oracle_mark_spread = cast_to_i128(mark_price)?
        .checked_sub(oracle_price)
        .ok_or_else(math_error!())?;

    let oracle_mark_twap_spread = cast_to_i128(market.amm.last_mark_price_twap)?
        .checked_sub(market.amm.last_oracle_price_twap)
        .ok_or_else(math_error!())?;

    let expected_excess_funding = oracle_mark_spread
        .checked_sub(oracle_mark_twap_spread)
        .ok_or_else(math_error!())?;

    let period_adjustment = cast_to_i128(
        TWENTYFOUR_HOUR
            .checked_div(max(ONE_HOUR, market.amm.funding_period))
            .ok_or_else(math_error!())?,
    )?;

    let expected_excess_funding_payment = market
        .base_asset_amount
        .checked_mul(expected_excess_funding)
        .ok_or_else(math_error!())?
        .checked_div(period_adjustment)
        .ok_or_else(math_error!())?
        .checked_div(FUNDING_EXCESS_TO_QUOTE_RATIO)
        .ok_or_else(math_error!())?;

    Ok(expected_excess_funding_payment)
}

pub fn calculate_fee_pool(market: &Market) -> ClearingHouseResult<u128> {
    let total_fee_minus_distributions_lower_bound = total_fee_lower_bound(market)?;

    let fee_pool =
        if market.amm.total_fee_minus_distributions > total_fee_minus_distributions_lower_bound {
            market
                .amm
                .total_fee_minus_distributions
                .checked_sub(total_fee_minus_distributions_lower_bound)
                .ok_or_else(math_error!())?
        } else {
            0
        };

    Ok(fee_pool)
}

pub fn total_fee_lower_bound(market: &Market) -> ClearingHouseResult<u128> {
    let total_fee_lb = market
        .amm
        .total_fee
        .checked_mul(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR)
        .ok_or_else(math_error!())?
        .checked_div(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR)
        .ok_or_else(math_error!())?;

    Ok(total_fee_lb)
}
