use crate::error::DriftResult;
use crate::error::ErrorCode;
use crate::math::constants::{
    MARGIN_PRECISION_U128, MAX_POSITIVE_UPNL_FOR_INITIAL_MARGIN, PRICE_PRECISION,
    SPOT_IMF_PRECISION_U128, SPOT_WEIGHT_PRECISION, SPOT_WEIGHT_PRECISION_U128,
};
use crate::math::position::{
    calculate_base_asset_value_and_pnl_with_oracle_price,
    calculate_base_asset_value_with_oracle_price,
};

use crate::{validate, PRICE_PRECISION_I128};
use crate::{validation, PRICE_PRECISION_I64};

use crate::math::casting::Cast;
use crate::math::funding::calculate_funding_payment;
use crate::math::oracle::{is_oracle_valid_for_action, DriftAction};

use crate::math::spot_balance::{get_strict_token_value, get_token_value};

use crate::math::safe_math::SafeMath;
use crate::state::margin_calculation::{MarginCalculation, MarginContext, MarketIdentifier};
use crate::state::oracle::{OraclePriceData, StrictOraclePrice};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{ContractTier, MarketStatus, PerpMarket};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::{AssetTier, SpotBalanceType};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::user::{OrderFillSimulation, PerpPosition, User};
use num_integer::Roots;
use solana_program::msg;
use std::cmp::{max, min, Ordering};

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, PartialEq, Debug, Eq)]
pub enum MarginRequirementType {
    Initial,
    Fill,
    Maintenance,
}

pub fn calculate_size_premium_liability_weight(
    size: u128, // AMM_RESERVE_PRECISION
    imf_factor: u32,
    liability_weight: u32,
    precision: u128,
) -> DriftResult<u32> {
    if imf_factor == 0 {
        return Ok(liability_weight);
    }

    let size_sqrt = ((size * 10) + 1).nth_root(2); //1e9 -> 1e10 -> 1e5

    let imf_factor_u128 = imf_factor.cast::<u128>()?;
    let liability_weight_u128 = liability_weight.cast::<u128>()?;
    let liability_weight_numerator =
        liability_weight_u128.safe_sub(liability_weight_u128.safe_div(5)?)?;

    // increases
    let size_premium_liability_weight = liability_weight_numerator
        .safe_add(
            size_sqrt // 1e5
                .safe_mul(imf_factor_u128)?
                .safe_div(100_000 * SPOT_IMF_PRECISION_U128 / precision)?, // 1e5 * 1e2
        )?
        .cast::<u32>()?;

    let max_liability_weight = max(liability_weight, size_premium_liability_weight);
    Ok(max_liability_weight)
}

pub fn calculate_size_discount_asset_weight(
    size: u128, // AMM_RESERVE_PRECISION
    imf_factor: u32,
    asset_weight: u32,
) -> DriftResult<u32> {
    if imf_factor == 0 {
        return Ok(asset_weight);
    }

    let size_sqrt = ((size * 10) + 1).nth_root(2); //1e9 -> 1e10 -> 1e5
    let imf_numerator = SPOT_IMF_PRECISION_U128 + SPOT_IMF_PRECISION_U128 / 10;

    let size_discount_asset_weight = imf_numerator
        .safe_mul(SPOT_WEIGHT_PRECISION_U128)?
        .safe_div(
            SPOT_IMF_PRECISION_U128
                .safe_add(size_sqrt.safe_mul(imf_factor.cast()?)?.safe_div(100_000)?)?,
        )?
        .cast::<u32>()?;

    let min_asset_weight = min(asset_weight, size_discount_asset_weight);

    Ok(min_asset_weight)
}

pub fn calculate_perp_position_value_and_pnl(
    market_position: &PerpPosition,
    market: &PerpMarket,
    oracle_price_data: &OraclePriceData,
    strict_quote_price: &StrictOraclePrice,
    margin_requirement_type: MarginRequirementType,
    user_custom_margin_ratio: u32,
    track_open_order_fraction: bool,
) -> DriftResult<(u128, i128, u128, u128)> {
    let valuation_price = if market.status == MarketStatus::Settlement {
        market.expiry_price
    } else {
        oracle_price_data.price
    };

    // the funding must be calculated before calculated the unrealized pnl w simulated lp position
    let unrealized_funding = calculate_funding_payment(
        if market_position.base_asset_amount > 0 {
            market.amm.cumulative_funding_rate_long
        } else {
            market.amm.cumulative_funding_rate_short
        },
        market_position,
    )?;

    let market_position = market_position.simulate_settled_lp_position(market, valuation_price)?;

    let (_, unrealized_pnl) =
        calculate_base_asset_value_and_pnl_with_oracle_price(&market_position, valuation_price)?;

    let total_unrealized_pnl = unrealized_pnl.safe_add(unrealized_funding.cast()?)?;

    let worst_case_base_asset_amount = market_position.worst_case_base_asset_amount()?;

    let worse_case_base_asset_value = calculate_base_asset_value_with_oracle_price(
        worst_case_base_asset_amount,
        valuation_price,
    )?;

    // for calculating the perps value, since it's a liability, use the large of twap and quote oracle price
    let worse_case_base_asset_value = worse_case_base_asset_value
        .safe_mul(strict_quote_price.max().cast()?)?
        .safe_div(PRICE_PRECISION)?;

    let margin_ratio = user_custom_margin_ratio.max(market.get_margin_ratio(
        worst_case_base_asset_amount.unsigned_abs(),
        margin_requirement_type,
    )?);

    let mut margin_requirement = if market.status == MarketStatus::Settlement {
        0
    } else {
        worse_case_base_asset_value
            .safe_mul(margin_ratio.cast()?)?
            .safe_div(MARGIN_PRECISION_U128)?
    };

    // add small margin requirement for every open order
    margin_requirement = margin_requirement
        .safe_add(market_position.margin_requirement_for_open_orders()?)?
        .safe_add(
            market_position
                .margin_requirement_for_lp_shares(market.amm.order_step_size, valuation_price)?,
        )?;

    let unrealized_asset_weight =
        market.get_unrealized_asset_weight(total_unrealized_pnl, margin_requirement_type)?;

    let quote_price = if total_unrealized_pnl > 0 {
        strict_quote_price.min()
    } else if total_unrealized_pnl < 0 {
        strict_quote_price.max()
    } else {
        strict_quote_price.current
    };

    let mut weighted_unrealized_pnl = total_unrealized_pnl;

    if unrealized_asset_weight != SPOT_WEIGHT_PRECISION {
        weighted_unrealized_pnl = weighted_unrealized_pnl
            .safe_mul(unrealized_asset_weight.cast()?)?
            .safe_div(SPOT_WEIGHT_PRECISION.cast()?)?;
    }
    if quote_price != PRICE_PRECISION_I64 {
        weighted_unrealized_pnl = weighted_unrealized_pnl
            .safe_mul(quote_price.cast()?)?
            .safe_div(PRICE_PRECISION_I128)?;
    }

    if margin_requirement_type == MarginRequirementType::Initial {
        // safety guard for dangerously configured perp market
        weighted_unrealized_pnl = weighted_unrealized_pnl.min(MAX_POSITIVE_UPNL_FOR_INITIAL_MARGIN);
    }

    let open_order_margin_requirement =
        if track_open_order_fraction && worst_case_base_asset_amount != 0 {
            let worst_case_base_asset_amount = worst_case_base_asset_amount.unsigned_abs();
            worst_case_base_asset_amount
                .safe_sub(market_position.base_asset_amount.unsigned_abs().cast()?)?
                .safe_mul(margin_requirement)?
                .safe_div(worst_case_base_asset_amount)?
        } else {
            0_u128
        };

    Ok((
        margin_requirement,
        weighted_unrealized_pnl,
        worse_case_base_asset_value,
        open_order_margin_requirement,
    ))
}

pub fn calculate_user_safest_position_tiers(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
) -> DriftResult<(AssetTier, ContractTier)> {
    let mut safest_tier_spot_liablity: AssetTier = AssetTier::default();
    let mut safest_tier_perp_liablity: ContractTier = ContractTier::default();

    for spot_position in user.spot_positions.iter() {
        if spot_position.is_available() || spot_position.balance_type == SpotBalanceType::Deposit {
            continue;
        }
        let spot_market = spot_market_map.get_ref(&spot_position.market_index)?;
        safest_tier_spot_liablity = min(safest_tier_spot_liablity, spot_market.asset_tier);
    }

    for market_position in user.perp_positions.iter() {
        if market_position.is_available() {
            continue;
        }
        let market = &perp_market_map.get_ref(&market_position.market_index)?;
        safest_tier_perp_liablity = min(safest_tier_perp_liablity, market.contract_tier);
    }

    Ok((safest_tier_spot_liablity, safest_tier_perp_liablity))
}

pub fn calculate_margin_requirement_and_total_collateral_and_liability_info(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    context: MarginContext,
) -> DriftResult<MarginCalculation> {
    let mut calculation = MarginCalculation::new(context);

    let user_custom_margin_ratio = if context.margin_type == MarginRequirementType::Initial {
        user.max_margin_ratio
    } else {
        0_u32
    };

    for spot_position in user.spot_positions.iter() {
        validation::position::validate_spot_position(spot_position)?;

        if spot_position.is_available() {
            continue;
        }

        let spot_market = spot_market_map.get_ref(&spot_position.market_index)?;
        let (oracle_price_data, oracle_validity) = oracle_map.get_price_data_and_validity(
            &spot_market.oracle,
            spot_market.historical_oracle_data.last_oracle_price_twap,
        )?;

        calculation.update_all_oracles_valid(is_oracle_valid_for_action(
            oracle_validity,
            Some(DriftAction::MarginCalc),
        )?);

        let strict_oracle_price = StrictOraclePrice::new(
            oracle_price_data.price,
            spot_market
                .historical_oracle_data
                .last_oracle_price_twap_5min,
            calculation.context.strict,
        );
        strict_oracle_price.validate()?;

        if spot_market.market_index == 0 {
            let token_amount = spot_position.get_signed_token_amount(&spot_market)?;
            if token_amount == 0 {
                validate!(
                    spot_position.scaled_balance == 0,
                    ErrorCode::InvalidMarginRatio,
                    "spot_position.scaled_balance={} when token_amount={}",
                    spot_position.scaled_balance,
                    token_amount,
                )?;
            }

            let token_value =
                get_strict_token_value(token_amount, spot_market.decimals, &strict_oracle_price)?;

            match spot_position.balance_type {
                SpotBalanceType::Deposit => {
                    calculation.add_total_collateral(token_value)?;
                }
                SpotBalanceType::Borrow => {
                    let token_value = token_value.unsigned_abs();

                    validate!(
                        token_value != 0,
                        ErrorCode::InvalidMarginRatio,
                        "token_value=0 for token_amount={} in spot market_index={}",
                        token_amount,
                        spot_market.market_index,
                    )?;

                    calculation.add_margin_requirement(
                        token_value,
                        token_value,
                        MarketIdentifier::spot(0),
                    )?;

                    calculation.add_spot_liability()?;
                }
            }
        } else {
            let signed_token_amount = spot_position.get_signed_token_amount(&spot_market)?;

            let OrderFillSimulation {
                token_amount: worst_case_token_amount,
                orders_value: worst_case_orders_value,
                token_value: worst_case_token_value,
                weighted_token_value: worst_case_weighted_token_value,
                ..
            } = spot_position
                .get_worst_case_fill_simulation(
                    &spot_market,
                    &strict_oracle_price,
                    Some(signed_token_amount),
                    context.margin_type,
                )?
                .apply_user_custom_margin_ratio(
                    &spot_market,
                    strict_oracle_price.current,
                    user_custom_margin_ratio,
                )?;

            if worst_case_token_amount == 0 {
                validate!(
                    spot_position.scaled_balance == 0,
                    ErrorCode::InvalidMarginRatio,
                    "spot_position.scaled_balance={} when worst_case_token_amount={}",
                    spot_position.scaled_balance,
                    worst_case_token_amount,
                )?;
            }

            calculation.add_margin_requirement(
                spot_position.margin_requirement_for_open_orders()?,
                0,
                MarketIdentifier::spot(spot_market.market_index),
            )?;

            match worst_case_token_value.cmp(&0) {
                Ordering::Greater => {
                    calculation
                        .add_total_collateral(worst_case_weighted_token_value.cast::<i128>()?)?;
                }
                Ordering::Less => {
                    validate!(
                        worst_case_weighted_token_value.unsigned_abs() >= worst_case_token_value.unsigned_abs(),
                        ErrorCode::InvalidMarginRatio,
                        "weighted_token_value < abs(worst_case_token_value) in spot market_index={}",
                        spot_market.market_index,
                    )?;

                    validate!(
                        worst_case_weighted_token_value != 0,
                        ErrorCode::InvalidOracle,
                        "weighted_token_value=0 for worst_case_token_amount={} in spot market_index={}",
                        worst_case_token_amount,
                        spot_market.market_index,
                    )?;

                    calculation.add_margin_requirement(
                        worst_case_weighted_token_value.unsigned_abs(),
                        worst_case_token_value.unsigned_abs(),
                        MarketIdentifier::spot(spot_market.market_index),
                    )?;

                    calculation.add_spot_liability()?;
                    calculation.update_with_isolated_liability(
                        spot_market.asset_tier == AssetTier::Isolated,
                    );
                }
                Ordering::Equal => {
                    if spot_position.has_open_order() {
                        calculation.add_spot_liability()?;
                        calculation.update_with_isolated_liability(
                            spot_market.asset_tier == AssetTier::Isolated,
                        );
                    }
                }
            }

            match worst_case_orders_value.cmp(&0) {
                Ordering::Greater => {
                    calculation.add_total_collateral(worst_case_orders_value.cast::<i128>()?)?;
                }
                Ordering::Less => {
                    calculation.add_margin_requirement(
                        worst_case_orders_value.unsigned_abs(),
                        worst_case_orders_value.unsigned_abs(),
                        MarketIdentifier::spot(0),
                    )?;
                }
                Ordering::Equal => {}
            }
        }
    }

    for market_position in user.perp_positions.iter() {
        if market_position.is_available() {
            continue;
        }

        let market = &perp_market_map.get_ref(&market_position.market_index)?;

        let quote_spot_market = spot_market_map.get_ref(&market.quote_spot_market_index)?;
        let (quote_oracle_price_data, quote_oracle_validity) = oracle_map
            .get_price_data_and_validity(
                &quote_spot_market.oracle,
                quote_spot_market
                    .historical_oracle_data
                    .last_oracle_price_twap,
            )?;

        calculation.update_all_oracles_valid(is_oracle_valid_for_action(
            quote_oracle_validity,
            Some(DriftAction::MarginCalc),
        )?);

        let strict_quote_price = StrictOraclePrice::new(
            quote_oracle_price_data.price,
            quote_spot_market
                .historical_oracle_data
                .last_oracle_price_twap_5min,
            calculation.context.strict,
        );
        drop(quote_spot_market);

        let (oracle_price_data, oracle_validity) = oracle_map.get_price_data_and_validity(
            &market.amm.oracle,
            market.amm.historical_oracle_data.last_oracle_price_twap,
        )?;

        let (
            perp_margin_requirement,
            weighted_pnl,
            worst_case_base_asset_value,
            open_order_margin_requirement,
        ) = calculate_perp_position_value_and_pnl(
            market_position,
            market,
            oracle_price_data,
            &strict_quote_price,
            context.margin_type,
            user_custom_margin_ratio,
            calculation.track_open_orders_fraction(),
        )?;

        calculation.add_margin_requirement(
            perp_margin_requirement,
            worst_case_base_asset_value,
            MarketIdentifier::perp(market.market_index),
        )?;

        if calculation.track_open_orders_fraction() {
            calculation.add_open_orders_margin_requirement(open_order_margin_requirement)?;
        }

        calculation.add_total_collateral(weighted_pnl)?;

        let has_perp_liability = market_position.base_asset_amount != 0
            || market_position.quote_asset_amount < 0
            || market_position.has_open_order()
            || market_position.is_lp();

        if has_perp_liability {
            calculation.add_perp_liability()?;
            calculation
                .update_with_isolated_liability(market.contract_tier == ContractTier::Isolated);
        }

        if has_perp_liability || calculation.context.margin_type != MarginRequirementType::Initial {
            calculation.update_all_oracles_valid(is_oracle_valid_for_action(
                oracle_validity,
                Some(DriftAction::MarginCalc),
            )?);
        }
    }

    calculation.validate_num_spot_liabilities()?;

    Ok(calculation)
}

pub fn meets_withdraw_margin_requirement(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    margin_requirement_type: MarginRequirementType,
) -> DriftResult<bool> {
    let strict = margin_requirement_type == MarginRequirementType::Initial;
    let context = MarginContext::standard(margin_requirement_type).strict(strict);

    let calculation = calculate_margin_requirement_and_total_collateral_and_liability_info(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        context,
    )?;

    if calculation.margin_requirement > 0 || calculation.get_num_of_liabilities()? > 0 {
        validate!(
            calculation.all_oracles_valid,
            ErrorCode::InvalidOracle,
            "User attempting to withdraw with outstanding liabilities when an oracle is invalid"
        )?;
    }

    if calculation.get_num_of_liabilities()? > 1 {
        validate!(
            !calculation.with_isolated_liability,
            ErrorCode::IsolatedAssetTierViolation,
            "User attempting to increase number of liabilities above 1 with a isolated tier liability"
        )?;
    }

    validate!(
        calculation.meets_margin_requirement(),
        ErrorCode::InsufficientCollateral,
        "User attempting to withdraw where total_collateral {} is below initial_margin_requirement {}",
        calculation.total_collateral,
        calculation.margin_requirement
    )?;

    Ok(true)
}

pub fn meets_place_order_margin_requirement(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    risk_increasing: bool,
) -> DriftResult {
    let margin_type = if risk_increasing {
        MarginRequirementType::Initial
    } else {
        MarginRequirementType::Maintenance
    };
    let context = MarginContext::standard(margin_type).strict(true);

    let calculation = calculate_margin_requirement_and_total_collateral_and_liability_info(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        context,
    )?;

    if !calculation.meets_margin_requirement() {
        msg!(
            "total_collateral={}, margin_requirement={} margin type = {:?}",
            calculation.total_collateral,
            calculation.margin_requirement,
            margin_type
        );
        return Err(ErrorCode::InsufficientCollateral);
    }

    if calculation.get_num_of_liabilities()? > 1 {
        validate!(
            !calculation.with_isolated_liability,
            ErrorCode::IsolatedAssetTierViolation,
            "User attempting to increase number of liabilities above 1 with a isolated tier liability"
        )?;
    }

    Ok(())
}

pub fn meets_initial_margin_requirement(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> DriftResult<bool> {
    calculate_margin_requirement_and_total_collateral_and_liability_info(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        MarginContext::standard(MarginRequirementType::Initial),
    )
    .map(|calc| calc.meets_margin_requirement())
}

pub fn meets_maintenance_margin_requirement(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> DriftResult<bool> {
    calculate_margin_requirement_and_total_collateral_and_liability_info(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        MarginContext::standard(MarginRequirementType::Maintenance),
    )
    .map(|calc| calc.meets_margin_requirement())
}

pub fn calculate_max_withdrawable_amount(
    market_index: u16,
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> DriftResult<u64> {
    let calculation = calculate_margin_requirement_and_total_collateral_and_liability_info(
        user,
        perp_market_map,
        spot_market_map,
        oracle_map,
        MarginContext::standard(MarginRequirementType::Initial),
    )?;

    let spot_market = &mut spot_market_map.get_ref(&market_index)?;

    let token_amount = user
        .get_spot_position(market_index)?
        .get_token_amount(spot_market)?;

    let oracle_price = oracle_map.get_price_data(&spot_market.oracle)?.price;

    let asset_weight = spot_market.get_asset_weight(
        token_amount,
        oracle_price,
        &MarginRequirementType::Initial,
    )?;

    if asset_weight == 0 {
        return Ok(u64::MAX);
    }

    if calculation.get_num_of_liabilities()? == 0 {
        // user has small dust deposit and no liabilities
        // so return early with user tokens amount
        return token_amount.cast();
    }

    let free_collateral = calculation.get_free_collateral()?;

    let precision_increase = 10u128.pow(spot_market.decimals - 6);

    free_collateral
        .safe_mul(MARGIN_PRECISION_U128)?
        .safe_div(asset_weight.cast()?)?
        .safe_mul(PRICE_PRECISION)?
        .safe_div(oracle_price.cast()?)?
        .safe_mul(precision_increase)?
        .cast()
}

pub fn validate_spot_margin_trading(
    user: &User,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> DriftResult {
    if user.is_margin_trading_enabled {
        return Ok(());
    }

    let mut total_open_bids_value = 0_i128;
    for spot_position in &user.spot_positions {
        let asks = spot_position.open_asks;
        if asks < 0 {
            let spot_market = spot_market_map.get_ref(&spot_position.market_index)?;
            let signed_token_amount = spot_position.get_signed_token_amount(&spot_market)?;
            // The user can have:
            // 1. no open asks with an existing short
            // 2. open asks with a larger existing long
            validate!(
                signed_token_amount.safe_add(asks.cast()?)? >= 0,
                ErrorCode::MarginTradingDisabled,
                "Open asks can lead to increased borrow in spot market {}",
                spot_position.market_index
            )?;
        }

        let bids = spot_position.open_bids;
        if bids > 0 {
            let spot_market = spot_market_map.get_ref(&spot_position.market_index)?;
            let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle)?;
            let open_bids_value =
                get_token_value(-bids as i128, spot_market.decimals, oracle_price_data.price)?;

            total_open_bids_value = total_open_bids_value.safe_add(open_bids_value)?;
        }
    }

    let mut quote_token_amount = 0_i128;
    let quote_spot_position = user.get_quote_spot_position();
    if !quote_spot_position.is_available() {
        let quote_spot_market = spot_market_map.get_quote_spot_market()?;
        quote_token_amount = quote_spot_position.get_signed_token_amount(&quote_spot_market)?;
    }

    // The user can have open bids if their value is less than existing quote token amount
    validate!(
        total_open_bids_value == 0 || quote_token_amount.safe_add(total_open_bids_value)? >= 0,
        ErrorCode::MarginTradingDisabled,
        "Open bids leads to increased borrow for spot market 0"
    )?;

    Ok(())
}

pub fn calculate_user_equity(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> DriftResult<(i128, bool)> {
    let mut net_usd_value: i128 = 0;
    let mut all_oracles_valid = true;

    for spot_position in user.spot_positions.iter() {
        if spot_position.is_available() {
            continue;
        }

        let spot_market = spot_market_map.get_ref(&spot_position.market_index)?;
        let (oracle_price_data, oracle_validity) = oracle_map.get_price_data_and_validity(
            &spot_market.oracle,
            spot_market.historical_oracle_data.last_oracle_price_twap,
        )?;
        all_oracles_valid &=
            is_oracle_valid_for_action(oracle_validity, Some(DriftAction::MarginCalc))?;

        let token_amount = spot_position.get_signed_token_amount(&spot_market)?;
        let oracle_price = oracle_price_data.price;
        let token_value = get_token_value(token_amount, spot_market.decimals, oracle_price)?;

        net_usd_value = net_usd_value.safe_add(token_value)?;
    }

    for market_position in user.perp_positions.iter() {
        if market_position.is_available() {
            continue;
        }

        let market = &perp_market_map.get_ref(&market_position.market_index)?;

        let quote_oracle_price = {
            let quote_spot_market = spot_market_map.get_ref(&market.quote_spot_market_index)?;
            let (quote_oracle_price_data, quote_oracle_validity) = oracle_map
                .get_price_data_and_validity(
                    &quote_spot_market.oracle,
                    quote_spot_market
                        .historical_oracle_data
                        .last_oracle_price_twap,
                )?;

            all_oracles_valid &=
                is_oracle_valid_for_action(quote_oracle_validity, Some(DriftAction::MarginCalc))?;

            quote_oracle_price_data.price
        };

        let (oracle_price_data, oracle_validity) = oracle_map.get_price_data_and_validity(
            &market.amm.oracle,
            market.amm.historical_oracle_data.last_oracle_price_twap,
        )?;

        all_oracles_valid &=
            is_oracle_valid_for_action(oracle_validity, Some(DriftAction::MarginCalc))?;

        let valuation_price = if market.status == MarketStatus::Settlement {
            market.expiry_price
        } else {
            oracle_price_data.price
        };

        let unrealized_funding = calculate_funding_payment(
            if market_position.base_asset_amount > 0 {
                market.amm.cumulative_funding_rate_long
            } else {
                market.amm.cumulative_funding_rate_short
            },
            market_position,
        )?;

        let market_position =
            market_position.simulate_settled_lp_position(market, valuation_price)?;

        let (_, unrealized_pnl) = calculate_base_asset_value_and_pnl_with_oracle_price(
            &market_position,
            valuation_price,
        )?;

        let pnl = unrealized_pnl.safe_add(unrealized_funding.cast()?)?;

        let pnl_value = pnl
            .safe_mul(quote_oracle_price.cast()?)?
            .safe_div(PRICE_PRECISION_I128)?;

        net_usd_value = net_usd_value.safe_add(pnl_value)?;
    }

    Ok((net_usd_value, all_oracles_valid))
}
