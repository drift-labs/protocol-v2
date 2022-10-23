use std::cmp::{max, min};

use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

use crate::error::*;
use crate::math::amm;
use crate::math::bn;
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_RESERVE_PRECISION_I128, BID_ASK_SPREAD_PRECISION_U128, PEG_PRECISION_I128,
    PRICE_TO_PEG_PRECISION_RATIO, SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR,
};
use crate::math::cp_curve;
use crate::math::oracle;
use crate::math::oracle::OracleValidity;
use crate::math::position::_calculate_base_asset_value_and_pnl;
use crate::math::safe_math::SafeMath;

use crate::state::oracle::get_oracle_price;
use crate::state::oracle::OraclePriceData;
use crate::state::perp_market::{PerpMarket, AMM};
use crate::state::state::OracleGuardRails;

#[cfg(test)]
mod tests;

pub fn calculate_repeg_validity_from_oracle_account(
    market: &PerpMarket,
    oracle_account_info: &AccountInfo,
    terminal_price_before: u64,
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
    terminal_price_before: u64,
) -> ClearingHouseResult<(bool, bool, bool, bool)> {
    let OraclePriceData {
        price: oracle_price,
        confidence: oracle_conf,
        delay: _,
        has_sufficient_number_of_data_points: _,
    } = *oracle_price_data;

    let oracle_price_u128 = oracle_price.cast::<u64>()?;

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

        let oracle_conf_band_top = oracle_price_u128.safe_add(oracle_conf)?;

        let oracle_conf_band_bottom = oracle_price_u128.safe_sub(oracle_conf)?;

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
    target_price: u64,
) -> ClearingHouseResult<u128> {
    let new_peg = bn::U192::from(target_price)
        .safe_mul(bn::U192::from(base_asset_reserve))?
        .safe_div(bn::U192::from(quote_asset_reserve))?
        .safe_add(bn::U192::from(PRICE_TO_PEG_PRECISION_RATIO / 2))?
        .safe_div(bn::U192::from(PRICE_TO_PEG_PRECISION_RATIO))?
        .try_to_u128()?;
    Ok(new_peg.max(1))
}

pub fn calculate_amm_target_price(
    amm: &AMM,
    current_price: u64,
    oracle_price_data: &OraclePriceData,
) -> ClearingHouseResult<u64> {
    // calculates peg_multiplier that changing to would cost no more than budget
    let oracle_price_normalised =
        amm::normalise_oracle_price(amm, oracle_price_data, Some(current_price))?.cast::<u64>()?;

    let weight_denom = 100_u128;

    let delay_penalty = max(
        0,
        oracle_price_data
            .delay
            .safe_mul(max(1, oracle_price_data.delay.safe_div(2)?))?,
    );

    let oracle_price_weight: u128 = max(0, 100_i64.safe_sub(delay_penalty)?).cast()?;

    let target_price = if oracle_price_weight > 0 {
        let current_price_weight: u128 = weight_denom.safe_sub(oracle_price_weight)?;

        oracle_price_normalised
            .cast::<u128>()?
            .safe_mul(oracle_price_weight)?
            .safe_div(weight_denom)?
            .safe_add(
                current_price
                    .cast::<u128>()?
                    .safe_mul(current_price_weight)?
                    .safe_div(weight_denom)?,
            )?
            .cast::<u64>()?
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
    amm.quote_asset_reserve
        .cast::<i128>()?
        .safe_sub(amm.terminal_quote_asset_reserve.cast()?)?
        .safe_mul(
            new_peg
                .cast::<i128>()?
                .safe_sub(amm.peg_multiplier.cast()?)?,
        )?
        .safe_div(AMM_RESERVE_PRECISION_I128)
}

pub fn calculate_per_peg_cost(
    quote_asset_reserve: u128,
    terminal_quote_asset_reserve: u128,
) -> ClearingHouseResult<i128> {
    // returns a signed per_peg_cost relative to delta peg
    let per_peg_cost = if quote_asset_reserve != terminal_quote_asset_reserve {
        quote_asset_reserve
            .cast::<i128>()?
            .safe_sub(terminal_quote_asset_reserve.cast::<i128>()?)?
            .safe_div(AMM_RESERVE_PRECISION_I128 / PEG_PRECISION_I128)?
            .safe_add(1)?
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
    let curve_update_intensity = min(market.amm.curve_update_intensity, 100_u8).cast::<i128>()?;

    // return early
    if optimal_peg == market.amm.peg_multiplier || curve_update_intensity == 0 {
        return Ok((Box::new(*market), 0));
    }

    let delta_peg = optimal_peg
        .cast::<i128>()?
        .safe_sub(market.amm.peg_multiplier.cast()?)?; // PEG_PRECISION

    let mut per_peg_cost = calculate_per_peg_cost(
        market.amm.quote_asset_reserve,
        market.amm.terminal_quote_asset_reserve,
    )?; // PEG_PRECISION

    let budget_i128 = budget.cast::<i128>()?;

    let mut market_clone = Box::new(*market);
    let mut budget_delta_peg: i128;
    let mut budget_delta_peg_magnitude: u128 = 0;
    let cost: i128;
    let new_peg: u128;

    if per_peg_cost != 0 {
        budget_delta_peg = budget_i128
            .safe_mul(PEG_PRECISION_I128)?
            .safe_div(per_peg_cost)?; // PEG_PRECISION
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
                .safe_sub(market.amm.sqrt_k.safe_div(1000)?)?;

            let new_base_asset_reserve = market
                .amm
                .base_asset_reserve
                .safe_sub(market.amm.base_asset_reserve.safe_div(1000)?)?;
            let new_quote_asset_reserve = market
                .amm
                .quote_asset_reserve
                .safe_sub(market.amm.quote_asset_reserve.safe_div(1000)?)?;

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
            .safe_add(adjustment_cost.abs())?
            .safe_mul(PEG_PRECISION_I128)?
            .safe_div(per_peg_cost)?;

        budget_delta_peg_magnitude = budget_delta_peg.unsigned_abs();
        new_peg = if budget_delta_peg > 0 {
            market
                .amm
                .peg_multiplier
                .safe_add(budget_delta_peg_magnitude)?
        } else {
            market
                .amm
                .peg_multiplier
                .safe_sub(budget_delta_peg_magnitude)?
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
    let target_price_i64 = oracle_price_data.price;
    let target_price = target_price_i64.cast()?;
    let mut optimal_peg = calculate_peg_from_target_price(
        market.amm.quote_asset_reserve,
        market.amm.base_asset_reserve,
        target_price,
    )?;

    let optimal_peg_cost = calculate_repeg_cost(&market.amm, optimal_peg)?;

    let mut check_lower_bound = true;
    if fee_budget < max(0, optimal_peg_cost).cast()? {
        let max_price_spread = target_price
            .cast::<u128>()?
            .safe_mul(market.amm.max_spread.cast()?)?
            .safe_div(BID_ASK_SPREAD_PRECISION_U128)?
            .cast::<i64>()?;

        let target_price_gap = reserve_price_before
            .cast::<i64>()?
            .safe_sub(target_price_i64)?;

        if target_price_gap.abs() > max_price_spread {
            let mark_adj = target_price_gap.abs().safe_sub(max_price_spread)?.cast()?;

            let target_price = if target_price_gap < 0 {
                reserve_price_before.safe_add(mark_adj)?
            } else {
                reserve_price_before.safe_sub(mark_adj)?
            };
            optimal_peg = calculate_peg_from_target_price(
                market.amm.quote_asset_reserve,
                market.amm.base_asset_reserve,
                target_price.cast()?,
            )?;
            fee_budget = calculate_repeg_cost(&market.amm, optimal_peg)?.cast::<u128>()?;
            check_lower_bound = false;
        }
    }

    Ok((optimal_peg, fee_budget, check_lower_bound))
}

pub fn calculate_fee_pool(market: &PerpMarket) -> ClearingHouseResult<u128> {
    let total_fee_minus_distributions_lower_bound = get_total_fee_lower_bound(market)?.cast()?;

    let fee_pool =
        if market.amm.total_fee_minus_distributions > total_fee_minus_distributions_lower_bound {
            market
                .amm
                .total_fee_minus_distributions
                .safe_sub(total_fee_minus_distributions_lower_bound)?
                .cast()?
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
        .safe_mul(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR)?
        .safe_div(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR)?;

    Ok(total_fee_lower_bound)
}
