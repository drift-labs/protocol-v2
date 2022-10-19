use std::cmp::{max, min};

use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

use crate::error::*;
use crate::math::amm;
use crate::math::bn;
use crate::math::casting::{cast_to_i128, cast_to_u128};
use crate::math::constants::{
    AMM_RESERVE_PRECISION_I128, AMM_TO_QUOTE_PRECISION_RATIO_I128, BID_ASK_SPREAD_PRECISION,
    ONE_HOUR, PEG_PRECISION_I128, PRICE_PRECISION_I128, PRICE_TO_PEG_PRECISION_RATIO,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR, TWENTY_FOUR_HOUR,
};
use crate::math::cp_curve;
use crate::math::oracle;
use crate::math::oracle::OracleValidity;
use crate::math::position::_calculate_base_asset_value_and_pnl;
use crate::math_error;
use crate::state::oracle::get_oracle_price;
use crate::state::oracle::OraclePriceData;
use crate::state::perp_market::{PerpMarket, AMM};
use crate::state::state::OracleGuardRails;

#[cfg(test)]
mod tests;

pub fn calculate_repeg_validity_from_oracle_account(
    market: &PerpMarket,
    oracle_account_info: &AccountInfo,
    terminal_price_before: u128,
    clock_slot: u64,
    oracle_guard_rails: &OracleGuardRails,
) -> ClearingHouseResult<(bool, bool, bool, bool)> {
    let oracle_price_data =
        get_oracle_price(&market.amm.oracle_source, oracle_account_info, clock_slot)?;
    let oracle_is_valid = oracle::oracle_validity(
        market.amm.historical_oracle_data.last_oracle_price_twap,
        &oracle_price_data,
        &oracle_guard_rails.validity,
    )? == OracleValidity::Valid;

    let (oracle_is_valid, direction_valid, profitability_valid, price_impact_valid) =
        calculate_repeg_validity(
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
    ))
}

pub fn calculate_repeg_validity(
    market: &PerpMarket,
    oracle_price_data: &OraclePriceData,
    oracle_is_valid: bool,
    terminal_price_before: u128,
) -> ClearingHouseResult<(bool, bool, bool, bool)> {
    let OraclePriceData {
        price: oracle_price,
        confidence: oracle_conf,
        delay: _,
        has_sufficient_number_of_data_points: _,
    } = *oracle_price_data;

    let oracle_price_u128 = cast_to_u128(oracle_price)?;

    let (terminal_price_after, _terminal_quote_reserves, _terminal_base_reserves) =
        amm::calculate_terminal_price_and_reserves(&market.amm)?;

    let mut direction_valid = true;
    let mut price_impact_valid = true;
    let mut profitability_valid = true;

    // if oracle is valid: check on size/direction of repeg
    if oracle_is_valid {
        let reserve_price_after = amm::calculate_price(
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
            if reserve_price_after > oracle_conf_band_top {
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
            if reserve_price_after < oracle_conf_band_bottom {
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
        .checked_add(bn::U192::from(PRICE_TO_PEG_PRECISION_RATIO / 2))
        .ok_or_else(math_error!())?
        .checked_div(bn::U192::from(PRICE_TO_PEG_PRECISION_RATIO))
        .ok_or_else(math_error!())?
        .try_to_u128()?;
    Ok(new_peg.max(1))
}

pub fn calculate_amm_target_price(
    amm: &AMM,
    current_price: u128,
    oracle_price_data: &OraclePriceData,
) -> ClearingHouseResult<u128> {
    // calculates peg_multiplier that changing to would cost no more than budget
    let oracle_price_normalised = cast_to_u128(amm::normalise_oracle_price(
        amm,
        oracle_price_data,
        Some(current_price),
    )?)?;

    let weight_denom = 100_u128;

    let delay_penalty = max(
        0,
        oracle_price_data
            .delay
            .checked_mul(max(
                1,
                oracle_price_data
                    .delay
                    .checked_div(2)
                    .ok_or_else(math_error!())?,
            ))
            .ok_or_else(math_error!())?,
    );

    let oracle_price_weight: u128 = cast_to_u128(max(
        0,
        100_i64
            .checked_sub(delay_penalty)
            .ok_or_else(math_error!())?,
    ))?;

    let target_price = if oracle_price_weight > 0 {
        let current_price_weight: u128 = weight_denom
            .checked_sub(oracle_price_weight)
            .ok_or_else(math_error!())?;

        oracle_price_normalised
            .checked_mul(oracle_price_weight)
            .ok_or_else(math_error!())?
            .checked_div(weight_denom)
            .ok_or_else(math_error!())?
            .checked_add(
                current_price
                    .checked_mul(current_price_weight)
                    .ok_or_else(math_error!())?
                    .checked_div(weight_denom)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?
    } else {
        current_price
    };

    Ok(target_price)
}

pub fn adjust_peg_cost(
    market: &PerpMarket,
    new_peg_candidate: u128,
) -> ClearingHouseResult<(PerpMarket, i128)> {
    let mut market_clone = *market;

    let cost = if new_peg_candidate != market_clone.amm.peg_multiplier {
        // Find the net market value before adjusting peg
        let (current_net_market_value, _) = _calculate_base_asset_value_and_pnl(
            market_clone.amm.base_asset_amount_with_amm,
            0,
            &market_clone.amm,
            false,
        )?;

        market_clone.amm.peg_multiplier = new_peg_candidate;

        let (_new_net_market_value, cost) = _calculate_base_asset_value_and_pnl(
            market_clone.amm.base_asset_amount_with_amm,
            current_net_market_value,
            &market_clone.amm,
            false,
        )?;
        cost
    } else {
        0_i128
    };

    Ok((market_clone, cost))
}

pub fn calculate_repeg_cost(amm: &AMM, new_peg: u128) -> ClearingHouseResult<i128> {
    let cost = cast_to_i128(amm.quote_asset_reserve)?
        .checked_sub(cast_to_i128(amm.terminal_quote_asset_reserve)?)
        .ok_or_else(math_error!())?
        .checked_mul(
            cast_to_i128(new_peg)?
                .checked_sub(cast_to_i128(amm.peg_multiplier)?)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION_I128)
        .ok_or_else(math_error!())?;

    Ok(cost)
}

pub fn calculate_per_peg_cost(
    quote_asset_reserve: u128,
    terminal_quote_asset_reserve: u128,
) -> ClearingHouseResult<i128> {
    // returns a signed per_peg_cost relative to delta peg
    let per_peg_cost = if quote_asset_reserve != terminal_quote_asset_reserve {
        cast_to_i128(quote_asset_reserve)?
            .checked_sub(cast_to_i128(terminal_quote_asset_reserve)?)
            .ok_or_else(math_error!())?
            .checked_div(AMM_RESERVE_PRECISION_I128 / PEG_PRECISION_I128)
            .ok_or_else(math_error!())?
            .checked_add(1)
            .ok_or_else(math_error!())?
    } else {
        0
    };

    Ok(per_peg_cost)
}

pub fn adjust_amm(
    market: &PerpMarket,
    optimal_peg: u128,
    budget: u128,
    adjust_k: bool,
) -> ClearingHouseResult<(Box<PerpMarket>, i128)> {
    let curve_update_intensity = cast_to_i128(min(market.amm.curve_update_intensity, 100_u8))?;

    // return early
    if optimal_peg == market.amm.peg_multiplier || curve_update_intensity == 0 {
        return Ok((Box::new(*market), 0));
    }

    let delta_peg = cast_to_i128(optimal_peg)?
        .checked_sub(cast_to_i128(market.amm.peg_multiplier)?)
        .ok_or_else(math_error!())?; // PEG_PRECISION

    let mut per_peg_cost = calculate_per_peg_cost(
        market.amm.quote_asset_reserve,
        market.amm.terminal_quote_asset_reserve,
    )?; // PEG_PRECISION

    let budget_i128 = cast_to_i128(budget)?;

    let mut market_clone = Box::new(*market);
    let mut budget_delta_peg: i128;
    let mut budget_delta_peg_magnitude: u128 = 0;
    let cost: i128;
    let new_peg: u128;

    if per_peg_cost != 0 {
        budget_delta_peg = budget_i128
            .checked_mul(PEG_PRECISION_I128)
            .ok_or_else(math_error!())?
            .checked_div(per_peg_cost)
            .ok_or_else(math_error!())?; // PEG_PRECISION
        budget_delta_peg_magnitude = budget_delta_peg.unsigned_abs();
    }

    if (per_peg_cost == 0 || per_peg_cost > 0 && delta_peg < 0 || per_peg_cost < 0 && delta_peg > 0)
        || (budget_delta_peg_magnitude > delta_peg.unsigned_abs())
    {
        // use optimal peg
        new_peg = optimal_peg;
        cost = calculate_repeg_cost(&market_clone.amm, new_peg)?;
    } else {
        // use full budget peg
        let can_lower_k = market.amm.can_lower_k()?;

        // equivalent to (but cheaper than) scaling down by .1%
        let adjustment_cost: i128 = if adjust_k && can_lower_k {
            // TODO can be off by 1?

            let new_sqrt_k = market
                .amm
                .sqrt_k
                .checked_sub(
                    market
                        .amm
                        .sqrt_k
                        .checked_div(1000)
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?;

            let new_base_asset_reserve = market
                .amm
                .base_asset_reserve
                .checked_sub(
                    market
                        .amm
                        .base_asset_reserve
                        .checked_div(1000)
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?;
            let new_quote_asset_reserve = market
                .amm
                .quote_asset_reserve
                .checked_sub(
                    market
                        .amm
                        .quote_asset_reserve
                        .checked_div(1000)
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?;

            let update_k_result = cp_curve::UpdateKResult {
                sqrt_k: new_sqrt_k,
                base_asset_reserve: new_base_asset_reserve,
                quote_asset_reserve: new_quote_asset_reserve,
            };

            let adjustment_cost =
                cp_curve::adjust_k_cost_and_update(&mut market_clone, &update_k_result)?;
            per_peg_cost = calculate_per_peg_cost(
                market_clone.amm.quote_asset_reserve,
                market_clone.amm.terminal_quote_asset_reserve,
            )?;
            adjustment_cost
        } else {
            0
        };
        budget_delta_peg = budget_i128
            .checked_add(adjustment_cost.abs())
            .ok_or_else(math_error!())?
            .checked_mul(PEG_PRECISION_I128)
            .ok_or_else(math_error!())?
            .checked_div(per_peg_cost)
            .ok_or_else(math_error!())?;

        budget_delta_peg_magnitude = budget_delta_peg.unsigned_abs();
        new_peg = if budget_delta_peg > 0 {
            market
                .amm
                .peg_multiplier
                .checked_add(budget_delta_peg_magnitude)
                .ok_or_else(math_error!())?
        } else {
            market
                .amm
                .peg_multiplier
                .checked_sub(budget_delta_peg_magnitude)
                .ok_or_else(math_error!())?
        };

        cost = calculate_repeg_cost(&market_clone.amm, new_peg)?;
    }

    market_clone.amm.peg_multiplier = new_peg;

    Ok((market_clone, cost))
}

pub fn calculate_optimal_peg_and_budget(
    market: &PerpMarket,
    oracle_price_data: &OraclePriceData,
) -> ClearingHouseResult<(u128, u128, bool)> {
    let reserve_price_before = market.amm.reserve_price()?;

    let mut fee_budget = calculate_fee_pool(market)?;
    let target_price_i128 = oracle_price_data.price;
    let target_price = cast_to_u128(target_price_i128)?;
    let mut optimal_peg = calculate_peg_from_target_price(
        market.amm.quote_asset_reserve,
        market.amm.base_asset_reserve,
        target_price,
    )?;

    let optimal_peg_cost = calculate_repeg_cost(&market.amm, optimal_peg)?;

    let mut check_lower_bound = true;
    if fee_budget < cast_to_u128(max(0, optimal_peg_cost))? {
        let max_price_spread = cast_to_i128(
            target_price
                .checked_mul(cast_to_u128(market.amm.max_spread)?)
                .ok_or_else(math_error!())?
                .checked_div(BID_ASK_SPREAD_PRECISION)
                .ok_or_else(math_error!())?,
        )?;

        let target_price_gap = cast_to_i128(reserve_price_before)?
            .checked_sub(target_price_i128)
            .ok_or_else(math_error!())?;

        if target_price_gap.abs() > max_price_spread {
            let mark_adj = cast_to_u128(
                target_price_gap
                    .abs()
                    .checked_sub(max_price_spread)
                    .ok_or_else(math_error!())?,
            )?;

            let target_price = if target_price_gap < 0 {
                reserve_price_before
                    .checked_add(mark_adj)
                    .ok_or_else(math_error!())?
            } else {
                reserve_price_before
                    .checked_sub(mark_adj)
                    .ok_or_else(math_error!())?
            };
            optimal_peg = calculate_peg_from_target_price(
                market.amm.quote_asset_reserve,
                market.amm.base_asset_reserve,
                target_price,
            )?;
            fee_budget = cast_to_u128(calculate_repeg_cost(&market.amm, optimal_peg)?)?;
            check_lower_bound = false;
        }
    }

    Ok((optimal_peg, fee_budget, check_lower_bound))
}

pub fn calculate_expected_excess_funding_payment(
    market: &PerpMarket,
    oracle_price: i128,
    reserve_price: u128,
) -> ClearingHouseResult<i128> {
    let oracle_reserve_price_spread = cast_to_i128(reserve_price)?
        .checked_sub(oracle_price)
        .ok_or_else(math_error!())?;

    let oracle_mark_twap_spread = cast_to_i128(market.amm.last_mark_price_twap)?
        .checked_sub(market.amm.historical_oracle_data.last_oracle_price_twap)
        .ok_or_else(math_error!())?;

    let expected_excess_funding = oracle_reserve_price_spread
        .checked_sub(oracle_mark_twap_spread)
        .ok_or_else(math_error!())?;

    let period_adjustment = cast_to_i128(
        TWENTY_FOUR_HOUR
            .checked_div(max(ONE_HOUR as i64, market.amm.funding_period))
            .ok_or_else(math_error!())?,
    )?;

    let base_asset_amount = market
        .amm
        .base_asset_amount_with_amm
        .checked_div(AMM_TO_QUOTE_PRECISION_RATIO_I128)
        .ok_or_else(math_error!())?;

    let adjusted_excess_funding = expected_excess_funding
        .checked_div(period_adjustment)
        .ok_or_else(math_error!())?
        .checked_div(PRICE_PRECISION_I128)
        .ok_or_else(math_error!())?;

    let expected_excess_funding_payment = base_asset_amount
        .checked_mul(adjusted_excess_funding)
        .ok_or_else(math_error!())?;

    Ok(expected_excess_funding_payment)
}

pub fn calculate_fee_pool(market: &PerpMarket) -> ClearingHouseResult<u128> {
    let total_fee_minus_distributions_lower_bound =
        cast_to_i128(get_total_fee_lower_bound(market)?)?;

    let fee_pool =
        if market.amm.total_fee_minus_distributions > total_fee_minus_distributions_lower_bound {
            cast_to_u128(
                market
                    .amm
                    .total_fee_minus_distributions
                    .checked_sub(total_fee_minus_distributions_lower_bound)
                    .ok_or_else(math_error!())?,
            )?
        } else {
            0
        };

    Ok(fee_pool)
}

pub fn get_total_fee_lower_bound(market: &PerpMarket) -> ClearingHouseResult<u128> {
    // market to retain half of exchange fees
    let total_fee_lower_bound = market
        .amm
        .total_exchange_fee
        .checked_mul(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR)
        .ok_or_else(math_error!())?
        .checked_div(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR)
        .ok_or_else(math_error!())?;

    Ok(total_fee_lower_bound)
}
