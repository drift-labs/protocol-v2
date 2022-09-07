use crate::error::*;
use crate::math::casting::cast_to_i128;

use crate::controller::amm::update_spreads;
use crate::error::ErrorCode;
use crate::load_mut;
use crate::math::amm;
use crate::math::repeg;
use crate::math_error;
use crate::state::market::Market;
use crate::state::market_map::MarketMap;
use crate::state::oracle::OraclePriceData;
use crate::state::oracle_map::OracleMap;
use crate::state::state::{OracleGuardRails, State};
use anchor_lang::prelude::AccountInfo;
use anchor_lang::prelude::*;
use solana_program::msg;
use std::cmp::min;

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
        amm::calculate_terminal_price_and_reserves(&market.amm)?;

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
    let cost_applied = apply_cost_to_market(market, adjustment_cost, true)?;
    if cost_applied {
        market.amm.peg_multiplier = new_peg_candidate;
    } else {
        return Err(ErrorCode::InvalidRepegProfitability);
    }

    Ok(adjustment_cost)
}

pub fn update_amms(
    market_map: &mut MarketMap,
    oracle_map: &mut OracleMap,
    state: &State,
    clock: &Clock,
) -> ClearingHouseResult<bool> {
    // up to ~60k compute units (per amm) worst case
    let clock_slot = clock.slot;
    let now = clock.unix_timestamp;

    let updated = true; // todo
    for (_key, market_account_loader) in market_map.0.iter_mut() {
        let market = &mut load_mut!(market_account_loader)?;
        let oracle_price_data = &oracle_map.get_price_data(&market.amm.oracle)?;
        _update_amm(market, oracle_price_data, state, now, clock_slot)?;
    }

    Ok(updated)
}

pub fn update_amm(
    market_index: u64,
    market_map: &MarketMap,
    oracle_map: &mut OracleMap,
    state: &State,
    clock: &Clock,
) -> ClearingHouseResult<i128> {
    let market = &mut market_map.get_ref_mut(&market_index)?;
    let oracle_price_data = oracle_map.get_price_data(&market.amm.oracle)?;
    _update_amm(
        market,
        oracle_price_data,
        state,
        clock.unix_timestamp,
        clock.slot,
    )
}

pub fn _update_amm(
    market: &mut Market,
    oracle_price_data: &OraclePriceData,
    state: &State,
    now: i64,
    clock_slot: u64,
) -> ClearingHouseResult<i128> {
    // 0-100
    let curve_update_intensity = cast_to_i128(min(market.amm.curve_update_intensity, 100_u8))?;

    let mut amm_update_cost = 0;
    if curve_update_intensity > 0 {
        let (optimal_peg, fee_budget, check_lower_bound) =
            repeg::calculate_optimal_peg_and_budget(market, oracle_price_data)?;
        let (repegged_market, repegged_cost) =
            repeg::adjust_amm(market, optimal_peg, fee_budget, true)?;

        let cost_applied = apply_cost_to_market(market, repegged_cost, check_lower_bound)?;

        if cost_applied {
            market.amm.base_asset_reserve = repegged_market.amm.base_asset_reserve;
            market.amm.quote_asset_reserve = repegged_market.amm.quote_asset_reserve;
            market.amm.sqrt_k = repegged_market.amm.sqrt_k;

            market.amm.terminal_quote_asset_reserve =
                repegged_market.amm.terminal_quote_asset_reserve;
            market.amm.peg_multiplier = repegged_market.amm.peg_multiplier;
            amm_update_cost = repegged_cost;
        }
    }
    let is_oracle_valid = amm::is_oracle_valid(
        &market.amm,
        oracle_price_data,
        &state.oracle_guard_rails.validity,
    )?;

    let mark_price_after = market.amm.mark_price()?;
    amm::update_oracle_price_twap(
        &mut market.amm,
        now,
        oracle_price_data,
        Some(mark_price_after),
    )?;

    if is_oracle_valid {
        market.amm.last_update_slot = clock_slot;
        market.amm.last_oracle_valid = true;
    } else {
        market.amm.last_oracle_valid = false;
    }

    update_spreads(&mut market.amm, mark_price_after)?;

    Ok(amm_update_cost)
}

pub fn apply_cost_to_market(
    market: &mut Market,
    cost: i128,
    check_lower_bound: bool,
) -> ClearingHouseResult<bool> {
    // positive cost is expense, negative cost is revenue
    // Reduce pnl to quote asset precision and take the absolute value
    if cost > 0 {
        let new_total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_sub(cost)
            .ok_or_else(math_error!())?;

        // Only a portion of the protocol fees are allocated to repegging
        // This checks that the total_fee_minus_distributions does not decrease too much after repeg
        if check_lower_bound {
            if new_total_fee_minus_distributions
                > cast_to_i128(repeg::get_total_fee_lower_bound(market)?)?
            {
                market.amm.total_fee_minus_distributions = new_total_fee_minus_distributions;
            } else {
                return Ok(false);
            }
        } else {
            market.amm.total_fee_minus_distributions = new_total_fee_minus_distributions;
        }
    } else {
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(cost.abs())
            .ok_or_else(math_error!())?;
    }

    market.amm.net_revenue_since_last_funding = market
        .amm
        .net_revenue_since_last_funding
        .checked_sub(cost as i64)
        .ok_or_else(math_error!())?;

    Ok(true)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, MARK_PRICE_PRECISION, MARK_PRICE_PRECISION_I128,
    };
    use crate::state::market::AMM;
    use crate::state::state::{PriceDivergenceGuardRails, ValidityGuardRails};
    #[test]
    pub fn update_amm_test() {
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 65 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 630153846154000,
                terminal_quote_asset_reserve: 64 * AMM_RESERVE_PRECISION,
                sqrt_k: 64 * AMM_RESERVE_PRECISION,
                peg_multiplier: 19_400_000,
                net_base_asset_amount: -(AMM_RESERVE_PRECISION as i128),
                mark_std: MARK_PRICE_PRECISION as u64,
                last_mark_price_twap_ts: 0,
                last_oracle_price_twap: 19_400 * MARK_PRICE_PRECISION_I128,
                base_spread: 250,
                curve_update_intensity: 100,
                max_spread: 55500,
                ..AMM::default()
            },
            margin_ratio_initial: 555, // max 1/.0555 = 18.018018018x leverage
            ..Market::default()
        };

        let state = State {
            oracle_guard_rails: OracleGuardRails {
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale: 10,
                    confidence_interval_max_size: 1000,
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            ..State::default()
        };

        let now = 10000;
        let slot = 81680085;
        let oracle_price_data = OraclePriceData {
            price: (12_400 * MARK_PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        let mark_price_before = market.amm.mark_price().unwrap();
        assert_eq!(mark_price_before, 188076686390578);
        market.amm.last_oracle_price_twap_5min = 189076686390578;
        market.amm.last_oracle_price_twap_ts = now - 100;
        let oracle_mark_spread_pct_before =
            amm::calculate_oracle_twap_5min_mark_spread_pct(&market.amm, Some(mark_price_before))
                .unwrap();
        assert_eq!(oracle_mark_spread_pct_before, -5316);
        let too_diverge = amm::is_oracle_mark_too_divergent(
            oracle_mark_spread_pct_before,
            &state.oracle_guard_rails.price_divergence,
        )
        .unwrap();
        assert!(!too_diverge);

        let cost_of_update =
            _update_amm(&mut market, &oracle_price_data, &state, now, slot).unwrap();

        let is_oracle_valid = amm::is_oracle_valid(
            &market.amm,
            &oracle_price_data,
            &state.oracle_guard_rails.validity,
        )
        .unwrap();
        let mark_price_after_prepeg = market.amm.mark_price().unwrap();
        assert_eq!(mark_price_after_prepeg, 130882003768079);

        let oracle_mark_spread_pct_before = amm::calculate_oracle_twap_5min_mark_spread_pct(
            &market.amm,
            Some(mark_price_after_prepeg),
        )
        .unwrap();
        assert_eq!(oracle_mark_spread_pct_before, -292478);
        let too_diverge = amm::is_oracle_mark_too_divergent(
            oracle_mark_spread_pct_before,
            &state.oracle_guard_rails.price_divergence,
        )
        .unwrap();
        assert!(too_diverge);

        let profit = market.amm.total_fee_minus_distributions;
        let peg = market.amm.peg_multiplier;
        assert_eq!(-cost_of_update, profit);
        assert!(is_oracle_valid);
        assert!(profit < 0);
        assert_eq!(profit, -5808834953);
        assert_eq!(peg, 13500402);

        let mark_price = market.amm.mark_price().unwrap();
        let (bid, ask) = market.amm.bid_ask_price(mark_price).unwrap();
        assert!(bid < mark_price);
        assert!(bid < ask);
        assert!(mark_price <= ask);
        assert_eq!(
            market.amm.long_spread + market.amm.short_spread,
            (market.margin_ratio_initial * 100) as u128
        );

        assert_eq!(bid, 123618052558950);
        assert!(bid < (oracle_price_data.price as u128));
        assert_eq!(ask, 130882003768079);
        assert_eq!(mark_price, 130882003768079);
        //(133487208381380-120146825282679)/133403830987014 == .1 (max spread)
        // 127060953641838
    }

    #[test]
    pub fn update_amm_test_bad_oracle() {
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 65 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 630153846154000,
                terminal_quote_asset_reserve: 64 * AMM_RESERVE_PRECISION,
                sqrt_k: 64 * AMM_RESERVE_PRECISION,
                peg_multiplier: 19_400_000,
                net_base_asset_amount: -(AMM_RESERVE_PRECISION as i128),
                mark_std: MARK_PRICE_PRECISION as u64,
                last_mark_price_twap_ts: 0,
                last_oracle_price_twap: 19_400 * MARK_PRICE_PRECISION_I128,
                base_spread: 250,
                curve_update_intensity: 100,
                max_spread: 55500,
                ..AMM::default()
            },
            margin_ratio_initial: 555, // max 1/.0555 = 18.018018018x leverage
            ..Market::default()
        };

        let state = State {
            oracle_guard_rails: OracleGuardRails {
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale: 10,
                    confidence_interval_max_size: 20000, //2%
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            ..State::default()
        };

        let now = 10000;
        let slot = 81680085;
        let oracle_price_data = OraclePriceData {
            price: (12_400 * MARK_PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 12,
            has_sufficient_number_of_data_points: true,
        };

        let _cost_of_update =
            _update_amm(&mut market, &oracle_price_data, &state, now, slot).unwrap();
        assert!(market.amm.last_update_slot == 0);

        let is_oracle_valid = amm::is_oracle_valid(
            &market.amm,
            &oracle_price_data,
            &state.oracle_guard_rails.validity,
        )
        .unwrap();
        assert!(!is_oracle_valid);
    }
}
