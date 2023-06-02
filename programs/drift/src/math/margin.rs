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

use crate::validation;
use crate::{validate, PRICE_PRECISION_I128};

use crate::math::casting::Cast;
use crate::math::funding::calculate_funding_payment;
use crate::math::oracle::{is_oracle_valid_for_action, DriftAction};

use crate::math::spot_balance::{
    get_balance_value_and_token_amount, get_strict_token_value, get_token_value,
};

use crate::math::safe_math::SafeMath;
use crate::state::oracle::OraclePriceData;
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{ContractTier, MarketStatus, PerpMarket};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::{AssetTier, SpotBalanceType, SpotMarket};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::user::{PerpPosition, SpotPosition, User};
use num_integer::Roots;
use solana_program::msg;
use std::cmp::{max, min, Ordering};
use std::ops::Neg;

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, PartialEq, Debug, Eq)]
pub enum MarginRequirementType {
    Initial,
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

pub fn calculate_spot_position_value(
    spot_position: &SpotPosition,
    spot_market: &SpotMarket,
    oracle_price_data: &OraclePriceData,
    margin_requirement_type: MarginRequirementType,
) -> DriftResult<u128> {
    let (balance_value, token_amount) =
        get_balance_value_and_token_amount(spot_position, spot_market, oracle_price_data)?;

    let balance_equity_value = match spot_position.balance_type {
        SpotBalanceType::Deposit => balance_value
            .safe_mul(
                spot_market
                    .get_asset_weight(token_amount, &margin_requirement_type)?
                    .cast()?,
            )?
            .safe_div(SPOT_WEIGHT_PRECISION_U128)?,
        SpotBalanceType::Borrow => balance_value
            .safe_mul(
                spot_market
                    .get_liability_weight(token_amount, &margin_requirement_type)?
                    .cast()?,
            )?
            .safe_div(SPOT_WEIGHT_PRECISION_U128)?,
    };

    Ok(balance_equity_value)
}

pub fn calculate_perp_position_value_and_pnl(
    market_position: &PerpPosition,
    market: &PerpMarket,
    oracle_price_data: &OraclePriceData,
    quote_oracle_price: i64,
    quote_oracle_twap: i64,
    margin_requirement_type: MarginRequirementType,
    user_custom_margin_ratio: u32,
    with_bounds: bool,
    strict: bool,
) -> DriftResult<(u128, i128, u128)> {
    let valuation_price = if market.status == MarketStatus::Settlement {
        market.expiry_price
    } else {
        oracle_price_data.price
    };

    let market_position = market_position.simulate_settled_lp_position(market, valuation_price)?;

    let total_unrealized_pnl =
        calculate_total_unrealized_perp_pnl(&market_position, market, valuation_price)?;

    let worst_case_base_asset_amount = market_position.worst_case_base_asset_amount()?;

    let worse_case_base_asset_value = calculate_base_asset_value_with_oracle_price(
        worst_case_base_asset_amount,
        valuation_price,
    )?;

    // for calculating the perps value, since it's a liability, use the large of twap and quote oracle price
    let quote_price = if strict {
        quote_oracle_price.max(quote_oracle_twap)
    } else {
        quote_oracle_price
    };

    let worse_case_base_asset_value = worse_case_base_asset_value
        .safe_mul(quote_price.cast()?)?
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
    margin_requirement =
        margin_requirement.safe_add(market_position.margin_requirement_for_open_orders()?)?;

    let unrealized_asset_weight =
        market.get_unrealized_asset_weight(total_unrealized_pnl, margin_requirement_type)?;

    let quote_price = if strict && total_unrealized_pnl > 0 {
        quote_oracle_price.min(quote_oracle_twap)
    } else if strict && total_unrealized_pnl < 0 {
        quote_oracle_price.max(quote_oracle_twap)
    } else {
        quote_oracle_price
    };

    let mut weighted_unrealized_pnl = total_unrealized_pnl
        .safe_mul(quote_price.cast()?)?
        .safe_div(PRICE_PRECISION_I128)?
        .safe_mul(unrealized_asset_weight.cast()?)?
        .safe_div(SPOT_WEIGHT_PRECISION.cast()?)?;

    if with_bounds && margin_requirement_type == MarginRequirementType::Initial {
        // safety guard for dangerously configured perp market
        weighted_unrealized_pnl = weighted_unrealized_pnl.min(MAX_POSITIVE_UPNL_FOR_INITIAL_MARGIN);
    }

    Ok((
        margin_requirement,
        weighted_unrealized_pnl,
        worse_case_base_asset_value,
    ))
}

pub fn calculate_total_unrealized_perp_pnl(
    market_position: &PerpPosition,
    market: &PerpMarket,
    valuation_price: i64,
) -> DriftResult<i128> {
    let unrealized_funding = calculate_funding_payment(
        if market_position.base_asset_amount > 0 {
            market.amm.cumulative_funding_rate_long
        } else {
            market.amm.cumulative_funding_rate_short
        },
        market_position,
    )?;

    let (_, unrealized_pnl) =
        calculate_base_asset_value_and_pnl_with_oracle_price(market_position, valuation_price)?;

    unrealized_pnl.safe_add(unrealized_funding.cast()?)
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
    margin_requirement_type: MarginRequirementType,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    margin_buffer_ratio: Option<u128>,
    strict: bool,
) -> DriftResult<(u128, i128, u128, bool, u8, bool)> {
    let mut total_collateral: i128 = 0;
    let mut margin_requirement: u128 = 0;
    let mut margin_requirement_plus_buffer: u128 = 0;
    let mut all_oracles_valid: bool = true;
    let mut num_spot_liabilities: u8 = 0;
    let mut num_perp_liabilities: u8 = 0;
    let mut with_isolated_liability: bool = false;

    let user_custom_margin_ratio = if margin_requirement_type == MarginRequirementType::Initial {
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
        all_oracles_valid &=
            is_oracle_valid_for_action(oracle_validity, Some(DriftAction::MarginCalc))?;

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

            let token_value = if strict {
                get_strict_token_value(
                    token_amount,
                    spot_market.decimals,
                    oracle_price_data,
                    spot_market
                        .historical_oracle_data
                        .last_oracle_price_twap_5min,
                )?
            } else {
                get_token_value(token_amount, spot_market.decimals, oracle_price_data.price)?
            };

            match spot_position.balance_type {
                SpotBalanceType::Deposit => {
                    total_collateral = total_collateral.safe_add(token_value)?
                }
                SpotBalanceType::Borrow => {
                    let token_value = token_value.unsigned_abs();
                    let liability_weight = user_custom_margin_ratio.max(SPOT_WEIGHT_PRECISION);
                    let weighted_token_value = token_value
                        .safe_mul(liability_weight.cast()?)?
                        .safe_div(SPOT_WEIGHT_PRECISION_U128)?;

                    validate!(
                        weighted_token_value >= token_value,
                        ErrorCode::InvalidMarginRatio,
                        "weighted_token_value={} < abs(token_amount={}) in spot market_index={}",
                        weighted_token_value,
                        token_amount,
                        spot_market.market_index,
                    )?;

                    validate!(
                        weighted_token_value != 0,
                        ErrorCode::InvalidMarginRatio,
                        "weighted_token_value=0 for token_amount={} in spot market_index={}",
                        token_amount,
                        spot_market.market_index,
                    )?;

                    margin_requirement = margin_requirement.safe_add(weighted_token_value)?;
                    num_spot_liabilities += 1;

                    if let Some(margin_buffer_ratio) = margin_buffer_ratio {
                        margin_requirement_plus_buffer = margin_requirement_plus_buffer.safe_add(
                            calculate_margin_requirement_with_buffer(
                                weighted_token_value,
                                token_value,
                                margin_buffer_ratio,
                            )?,
                        )?;
                    }
                }
            }
        } else {
            let signed_token_amount = spot_position.get_signed_token_amount(&spot_market)?;
            let (worst_case_token_amount, worst_case_orders_value): (i128, i128) = spot_position
                .get_worst_case_token_amount(
                    &spot_market,
                    oracle_price_data,
                    if strict {
                        Some(
                            spot_market
                                .historical_oracle_data
                                .last_oracle_price_twap_5min,
                        )
                    } else {
                        None
                    },
                    Some(signed_token_amount),
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

            let signed_token_value = if strict {
                get_strict_token_value(
                    signed_token_amount,
                    spot_market.decimals,
                    oracle_price_data,
                    spot_market
                        .historical_oracle_data
                        .last_oracle_price_twap_5min,
                )?
            } else {
                get_token_value(
                    signed_token_amount,
                    spot_market.decimals,
                    oracle_price_data.price,
                )?
            };

            // the worst case token value is the deposit/borrow amount * oracle + worst case order size * oracle
            let worst_case_token_value =
                signed_token_value.safe_add(worst_case_orders_value.neg())?;

            margin_requirement =
                margin_requirement.safe_add(spot_position.margin_requirement_for_open_orders()?)?;

            match worst_case_token_amount.cmp(&0) {
                Ordering::Greater => {
                    let weighted_token_value = worst_case_token_value
                        .unsigned_abs()
                        .safe_mul(
                            spot_market
                                .get_asset_weight(
                                    worst_case_token_amount.unsigned_abs(),
                                    &margin_requirement_type,
                                )?
                                .cast()?,
                        )?
                        .safe_div(SPOT_WEIGHT_PRECISION_U128)?;

                    total_collateral =
                        total_collateral.safe_add(weighted_token_value.cast::<i128>()?)?;
                }
                Ordering::Less => {
                    let liability_weight =
                        user_custom_margin_ratio.max(spot_market.get_liability_weight(
                            worst_case_token_amount.unsigned_abs(),
                            &margin_requirement_type,
                        )?);

                    let weighted_token_value = worst_case_token_value
                        .unsigned_abs()
                        .safe_mul(liability_weight.cast()?)?
                        .safe_div(SPOT_WEIGHT_PRECISION_U128)?;

                    validate!(
                        weighted_token_value >= worst_case_token_value.unsigned_abs(),
                        ErrorCode::InvalidMarginRatio,
                        "weighted_token_value < abs(worst_case_token_value) in spot market_index={}",
                        spot_market.market_index,
                    )?;

                    validate!(
                        weighted_token_value != 0,
                        ErrorCode::InvalidOracle,
                        "weighted_token_value=0 for worst_case_token_amount={} in spot market_index={}",
                        worst_case_token_amount,
                        spot_market.market_index,
                    )?;

                    margin_requirement = margin_requirement.safe_add(weighted_token_value)?;

                    if let Some(margin_buffer_ratio) = margin_buffer_ratio {
                        margin_requirement_plus_buffer = margin_requirement_plus_buffer.safe_add(
                            calculate_margin_requirement_with_buffer(
                                weighted_token_value,
                                worst_case_token_value.unsigned_abs(),
                                margin_buffer_ratio,
                            )?,
                        )?;
                    }

                    num_spot_liabilities += 1;
                    with_isolated_liability &= spot_market.asset_tier == AssetTier::Isolated;
                }
                Ordering::Equal => {
                    if spot_position.has_open_order() {
                        num_spot_liabilities += 1;
                    }
                }
            }

            match worst_case_orders_value.cmp(&0) {
                Ordering::Greater => {
                    total_collateral =
                        total_collateral.safe_add(worst_case_orders_value.cast::<i128>()?)?
                }
                Ordering::Less => {
                    let liability_weight = user_custom_margin_ratio.max(SPOT_WEIGHT_PRECISION);
                    let weighted_token_value = worst_case_orders_value
                        .unsigned_abs()
                        .safe_mul(liability_weight.cast()?)?
                        .safe_div(SPOT_WEIGHT_PRECISION_U128)?;

                    margin_requirement = margin_requirement.safe_add(weighted_token_value)?;

                    if let Some(margin_buffer_ratio) = margin_buffer_ratio {
                        margin_requirement_plus_buffer = margin_requirement_plus_buffer.safe_add(
                            calculate_margin_requirement_with_buffer(
                                weighted_token_value,
                                worst_case_orders_value.unsigned_abs(),
                                margin_buffer_ratio,
                            )?,
                        )?;
                    }
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

        let (quote_oracle_price, quote_oracle_twap) = {
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

            (
                quote_oracle_price_data.price,
                quote_spot_market
                    .historical_oracle_data
                    .last_oracle_price_twap_5min,
            )
        };

        let (oracle_price_data, oracle_validity) = oracle_map.get_price_data_and_validity(
            &market.amm.oracle,
            market.amm.historical_oracle_data.last_oracle_price_twap,
        )?;
        all_oracles_valid &=
            is_oracle_valid_for_action(oracle_validity, Some(DriftAction::MarginCalc))?;

        let (perp_margin_requirement, weighted_pnl, worst_case_base_asset_value) =
            calculate_perp_position_value_and_pnl(
                market_position,
                market,
                oracle_price_data,
                quote_oracle_price,
                quote_oracle_twap,
                margin_requirement_type,
                user_custom_margin_ratio,
                true,
                strict,
            )?;

        margin_requirement = margin_requirement.safe_add(perp_margin_requirement)?;

        if let Some(margin_buffer_ratio) = margin_buffer_ratio {
            margin_requirement_plus_buffer = margin_requirement_plus_buffer.safe_add(
                calculate_margin_requirement_with_buffer(
                    perp_margin_requirement,
                    worst_case_base_asset_value,
                    margin_buffer_ratio,
                )?,
            )?;
        }

        total_collateral = total_collateral.safe_add(weighted_pnl)?;

        if market_position.base_asset_amount != 0
            || market_position.quote_asset_amount < 0
            || market_position.has_open_order()
        {
            num_perp_liabilities += 1;
        }

        with_isolated_liability &=
            margin_requirement > 0 && market.contract_tier == ContractTier::Isolated;
    }

    if num_spot_liabilities > 0 {
        validate!(
            margin_requirement > 0,
            ErrorCode::InvalidMarginRatio,
            "num_spot_liabilities={} but margin_requirement=0",
            num_spot_liabilities
        )?;
    }

    let num_of_liabilities = num_perp_liabilities.safe_add(num_spot_liabilities)?;
    Ok((
        margin_requirement,
        total_collateral,
        margin_requirement_plus_buffer,
        all_oracles_valid,
        num_of_liabilities,
        with_isolated_liability,
    ))
}

pub fn calculate_margin_requirement_and_total_collateral(
    user: &User,
    perp_market_map: &PerpMarketMap,
    margin_requirement_type: MarginRequirementType,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    margin_buffer_ratio: Option<u128>,
) -> DriftResult<(u128, i128, u128, bool)> {
    let (
        margin_requirement,
        total_collateral,
        margin_requirement_plus_buffer,
        all_oracles_valid,
        _,
        _,
    ) = calculate_margin_requirement_and_total_collateral_and_liability_info(
        user,
        perp_market_map,
        margin_requirement_type,
        spot_market_map,
        oracle_map,
        margin_buffer_ratio,
        false,
    )?;

    Ok((
        margin_requirement,
        total_collateral,
        margin_requirement_plus_buffer,
        all_oracles_valid,
    ))
}

pub fn meets_withdraw_margin_requirement(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    margin_requirement_type: MarginRequirementType,
) -> DriftResult<bool> {
    let strict = margin_requirement_type == MarginRequirementType::Initial;

    let (
        initial_margin_requirement,
        total_collateral,
        _,
        oracles_valid,
        num_of_liabilities,
        includes_isolated_liability,
    ) = calculate_margin_requirement_and_total_collateral_and_liability_info(
        user,
        perp_market_map,
        margin_requirement_type,
        spot_market_map,
        oracle_map,
        None,
        strict,
    )?;

    if initial_margin_requirement > 0 {
        validate!(
            oracles_valid,
            ErrorCode::InvalidOracle,
            "User attempting to withdraw with outstanding liabilities when an oracle is invalid"
        )?;
    }

    if num_of_liabilities > 1 {
        validate!(
            !includes_isolated_liability,
            ErrorCode::IsolatedAssetTierViolation,
            "User attempting to increase number of liabilities above 1 with a isolated tier liability"
        )?;
    }

    validate!(
        total_collateral >= initial_margin_requirement.cast::<i128>()?,
        ErrorCode::InsufficientCollateral,
        "User attempting to withdraw where total_collateral {} is below initial_margin_requirement {}",
        total_collateral,
        initial_margin_requirement
    )?;

    Ok(true)
}

fn calculate_margin_requirement_with_buffer(
    margin_requirement: u128,
    liability_value: u128,
    buffer_ratio: u128,
) -> DriftResult<u128> {
    margin_requirement.safe_add(liability_value.safe_mul(buffer_ratio)? / MARGIN_PRECISION_U128)
}

pub fn meets_place_order_margin_requirement(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    risk_decreasing: bool,
) -> DriftResult<bool> {
    let (
        margin_requirement,
        total_collateral,
        _,
        _,
        num_of_liabilities,
        includes_isolated_liability,
    ) = calculate_margin_requirement_and_total_collateral_and_liability_info(
        user,
        perp_market_map,
        MarginRequirementType::Initial,
        spot_market_map,
        oracle_map,
        None,
        true,
    )?;

    let meets_initial_margin_requirement = total_collateral >= margin_requirement.cast::<i128>()?;

    if !meets_initial_margin_requirement && !risk_decreasing {
        return Err(ErrorCode::InsufficientCollateral);
    }

    if num_of_liabilities > 1 {
        validate!(
            !includes_isolated_liability,
            ErrorCode::IsolatedAssetTierViolation,
            "User attempting to increase number of liabilities above 1 with a isolated tier liability"
        )?;
    }

    Ok(true)
}

pub fn meets_initial_margin_requirement(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> DriftResult<bool> {
    let (margin_requirement, total_collateral, _, _) =
        calculate_margin_requirement_and_total_collateral(
            user,
            perp_market_map,
            MarginRequirementType::Initial,
            spot_market_map,
            oracle_map,
            None,
        )?;
    Ok(total_collateral >= margin_requirement.cast::<i128>()?)
}

pub fn meets_maintenance_margin_requirement(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> DriftResult<bool> {
    let (margin_requirement, total_collateral, _, _) =
        calculate_margin_requirement_and_total_collateral(
            user,
            perp_market_map,
            MarginRequirementType::Maintenance,
            spot_market_map,
            oracle_map,
            None,
        )?;

    Ok(total_collateral >= margin_requirement.cast::<i128>()?)
}

pub fn calculate_free_collateral(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> DriftResult<i128> {
    let (margin_requirement, total_collateral, _, _) =
        calculate_margin_requirement_and_total_collateral(
            user,
            perp_market_map,
            MarginRequirementType::Initial,
            spot_market_map,
            oracle_map,
            None,
        )?;

    total_collateral.safe_sub(margin_requirement.cast::<i128>()?)
}

pub fn calculate_max_withdrawable_amount(
    market_index: u16,
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> DriftResult<u64> {
    let (margin_requirement, total_collateral, _, _, num_of_liabilities, _) =
        calculate_margin_requirement_and_total_collateral_and_liability_info(
            user,
            perp_market_map,
            MarginRequirementType::Initial,
            spot_market_map,
            oracle_map,
            None,
            false,
        )?;

    let spot_market = &mut spot_market_map.get_ref(&market_index)?;

    if num_of_liabilities == 0 {
        // user has small dust deposit and no liabilities
        // so return early with user tokens amount
        return user
            .get_spot_position(market_index)?
            .get_token_amount(spot_market)?
            .cast();
    }

    let free_collateral = total_collateral
        .safe_sub(margin_requirement.cast::<i128>()?)?
        .max(0)
        .cast::<u128>()?;

    let precision_increase = 10u128.pow(spot_market.decimals - 6);

    let oracle_price = oracle_map.get_price_data(&spot_market.oracle)?.price;

    free_collateral
        .safe_mul(MARGIN_PRECISION_U128)?
        .safe_div(spot_market.initial_asset_weight.cast()?)?
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

    let quote_spot_market = spot_market_map.get_quote_spot_market()?;
    let quote_token_amount = user
        .get_quote_spot_position()
        .get_signed_token_amount(&quote_spot_market)?;

    // The user can have open bids if their value is less than existing quote token amount
    validate!(
        total_open_bids_value == 0 || quote_token_amount.safe_add(total_open_bids_value)? >= 0,
        ErrorCode::MarginTradingDisabled,
        "Open bids leads to increased borrow for spot market 0"
    )?;

    Ok(())
}

pub fn calculate_net_usd_value(
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

        let market_position =
            market_position.simulate_settled_lp_position(market, valuation_price)?;

        let pnl = calculate_total_unrealized_perp_pnl(&market_position, market, valuation_price)?;

        let pnl_value = pnl
            .safe_mul(quote_oracle_price.cast()?)?
            .safe_div(PRICE_PRECISION_I128)?;

        net_usd_value = net_usd_value.safe_add(pnl_value)?;
    }

    Ok((net_usd_value, all_oracles_valid))
}
