use crate::error::ClearingHouseResult;
use crate::error::ErrorCode;
use crate::math::constants::{MARGIN_PRECISION, SPOT_IMF_PRECISION, SPOT_WEIGHT_PRECISION};
use crate::math::position::{
    calculate_base_asset_value_and_pnl_with_oracle_price,
    calculate_base_asset_value_with_oracle_price,
};
use crate::math_error;

use crate::state::user::User;
use crate::validate;

use crate::math::casting::{cast_to_i128, Cast};
use crate::math::funding::calculate_funding_payment;
use crate::math::lp::{calculate_lp_open_bids_asks, calculate_settle_lp_metrics};
use crate::math::oracle::{is_oracle_valid_for_action, DriftAction};

use crate::math::spot_balance::{get_balance_value_and_token_amount, get_token_value};

use crate::state::oracle::OraclePriceData;
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{MarketStatus, PerpMarket};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::{AssetTier, SpotBalanceType, SpotMarket};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::user::{PerpPosition, SpotPosition};
use num_integer::Roots;
use solana_program::msg;
use std::cmp::{max, min, Ordering};

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, PartialEq, Debug, Eq)]
pub enum MarginRequirementType {
    Initial,
    Maintenance,
}

pub fn calculate_size_premium_liability_weight(
    size: u128, // AMM_RESERVE_PRECISION
    imf_factor: u128,
    liability_weight: u128,
    precision: u128,
) -> ClearingHouseResult<u128> {
    if imf_factor == 0 {
        return Ok(liability_weight);
    }

    let size_sqrt = ((size * 10) + 1).nth_root(2); //1e9 -> 1e10 -> 1e5

    let liability_weight_numerator = liability_weight
        .checked_sub(
            liability_weight
                .checked_div(max(1, SPOT_IMF_PRECISION / imf_factor))
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    // increases
    let size_premium_liability_weight = liability_weight_numerator
        .checked_add(
            size_sqrt // 1e5
                .checked_mul(imf_factor)
                .ok_or_else(math_error!())?
                .checked_div(100_000 * SPOT_IMF_PRECISION / precision) // 1e5 * 1e2
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    let max_liability_weight = max(liability_weight, size_premium_liability_weight);
    Ok(max_liability_weight)
}

pub fn calculate_size_discount_asset_weight(
    size: u128, // AMM_RESERVE_PRECISION
    imf_factor: u128,
    asset_weight: u128,
) -> ClearingHouseResult<u128> {
    if imf_factor == 0 {
        return Ok(asset_weight);
    }

    let size_sqrt = ((size * 10) + 1).nth_root(2); //1e9 -> 1e10 -> 1e5
    let imf_numerator = SPOT_IMF_PRECISION + SPOT_IMF_PRECISION / 10;

    let size_discount_asset_weight = imf_numerator
        .checked_mul(SPOT_WEIGHT_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(
            SPOT_IMF_PRECISION
                .checked_add(
                    size_sqrt // 1e5
                        .checked_mul(imf_factor)
                        .ok_or_else(math_error!())?
                        .checked_div(100_000) // 1e5
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    let min_asset_weight = min(asset_weight, size_discount_asset_weight);

    Ok(min_asset_weight)
}

pub fn calculate_spot_position_value(
    spot_position: &SpotPosition,
    spot_market: &SpotMarket,
    oracle_price_data: &OraclePriceData,
    margin_requirement_type: MarginRequirementType,
) -> ClearingHouseResult<u128> {
    let (balance_value, token_amount) =
        get_balance_value_and_token_amount(spot_position, spot_market, oracle_price_data)?;

    let balance_equity_value = match spot_position.balance_type {
        SpotBalanceType::Deposit => balance_value
            .checked_mul(spot_market.get_asset_weight(token_amount, &margin_requirement_type)?)
            .ok_or_else(math_error!())?
            .checked_div(SPOT_WEIGHT_PRECISION)
            .ok_or_else(math_error!())?,
        SpotBalanceType::Borrow => balance_value
            .checked_mul(spot_market.get_liability_weight(token_amount, &margin_requirement_type)?)
            .ok_or_else(math_error!())?
            .checked_div(SPOT_WEIGHT_PRECISION)
            .ok_or_else(math_error!())?,
    };

    Ok(balance_equity_value)
}

pub fn calculate_perp_position_value_and_pnl(
    market_position: &PerpPosition,
    market: &PerpMarket,
    oracle_price_data: &OraclePriceData,
    margin_requirement_type: MarginRequirementType,
    user_custom_margin_ratio: u128,
) -> ClearingHouseResult<(u128, i128, u128)> {
    let unrealized_funding = calculate_funding_payment(
        if market_position.base_asset_amount > 0 {
            market.amm.cumulative_funding_rate_long
        } else {
            market.amm.cumulative_funding_rate_short
        },
        market_position,
    )?;

    let market_position = if market_position.is_lp() {
        // compute lp metrics
        let lp_metrics = calculate_settle_lp_metrics(&market.amm, market_position)?;

        // compute settled position
        let base_asset_amount = market_position
            .base_asset_amount
            .checked_add(lp_metrics.base_asset_amount.cast()?)
            .ok_or_else(math_error!())?;

        let mut quote_asset_amount = market_position
            .quote_asset_amount
            .checked_add(lp_metrics.quote_asset_amount.cast()?)
            .ok_or_else(math_error!())?;

        // dust position in baa/qaa
        if lp_metrics.remainder_base_asset_amount != 0 {
            let dust_base_asset_value = calculate_base_asset_value_with_oracle_price(
                lp_metrics.remainder_base_asset_amount.cast()?,
                oracle_price_data.price,
            )?
            .checked_add(1)
            .ok_or_else(math_error!())?;

            quote_asset_amount = quote_asset_amount
                .checked_sub(dust_base_asset_value.cast()?)
                .ok_or_else(math_error!())?;
        }

        let (lp_bids, lp_asks) = calculate_lp_open_bids_asks(market_position, market)?;

        let open_bids = market_position
            .open_bids
            .checked_add(lp_bids)
            .ok_or_else(math_error!())?;

        let open_asks = market_position
            .open_asks
            .checked_add(lp_asks)
            .ok_or_else(math_error!())?;

        PerpPosition {
            base_asset_amount,
            quote_asset_amount,
            open_asks,
            open_bids,
            // todo double check: this is ok because no other values are used in the future computations
            ..PerpPosition::default()
        }
    } else {
        *market_position
    };

    let valuation_price = if market.status == MarketStatus::Settlement {
        market.expiry_price
    } else {
        oracle_price_data.price
    };

    let (_, unrealized_pnl) =
        calculate_base_asset_value_and_pnl_with_oracle_price(&market_position, valuation_price)?;

    let total_unrealized_pnl = unrealized_pnl
        .checked_add(unrealized_funding.cast()?)
        .ok_or_else(math_error!())?;

    let worst_case_base_asset_amount = market_position.worst_case_base_asset_amount()?;

    let worse_case_base_asset_value = calculate_base_asset_value_with_oracle_price(
        worst_case_base_asset_amount,
        valuation_price,
    )?;

    let margin_ratio = user_custom_margin_ratio.max(market.get_margin_ratio(
        worst_case_base_asset_amount.unsigned_abs(),
        margin_requirement_type,
    )? as u128);

    let margin_requirement = worse_case_base_asset_value
        .checked_mul(margin_ratio)
        .ok_or_else(math_error!())?
        .checked_div(MARGIN_PRECISION)
        .ok_or_else(math_error!())?;

    let unrealized_asset_weight =
        market.get_unrealized_asset_weight(total_unrealized_pnl, margin_requirement_type)?;

    let weighted_unrealized_pnl = total_unrealized_pnl
        .checked_mul(unrealized_asset_weight as i128)
        .ok_or_else(math_error!())?
        .checked_div(SPOT_WEIGHT_PRECISION as i128)
        .ok_or_else(math_error!())?;

    Ok((
        margin_requirement,
        weighted_unrealized_pnl,
        worse_case_base_asset_value,
    ))
}

pub fn calculate_margin_requirement_and_total_collateral_and_liability_info(
    user: &User,
    perp_market_map: &PerpMarketMap,
    margin_requirement_type: MarginRequirementType,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    margin_buffer_ratio: Option<u128>,
) -> ClearingHouseResult<(u128, i128, u128, bool, u8, bool)> {
    let mut total_collateral: i128 = 0;
    let mut margin_requirement: u128 = 0;
    let mut margin_requirement_plus_buffer: u128 = 0;
    let mut all_oracles_valid: bool = true;
    let mut num_of_liabilities: u8 = 0;
    let mut with_isolated_liability: bool = false;

    let user_custom_margin_ratio = if margin_requirement_type == MarginRequirementType::Initial {
        user.max_margin_ratio as u128
    } else {
        0_u128
    };

    for spot_position in user.spot_positions.iter() {
        if spot_position.balance == 0 && spot_position.open_orders == 0 {
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
            let token_amount = spot_position.get_token_amount(&spot_market)?;

            match spot_position.balance_type {
                SpotBalanceType::Deposit => {
                    total_collateral = total_collateral
                        .checked_add(cast_to_i128(token_amount)?)
                        .ok_or_else(math_error!())?
                }
                SpotBalanceType::Borrow => {
                    let liability_weight = user_custom_margin_ratio.max(SPOT_WEIGHT_PRECISION);
                    let weighted_token_value = token_amount
                        .checked_mul(liability_weight)
                        .ok_or_else(math_error!())?
                        .checked_div(SPOT_WEIGHT_PRECISION)
                        .ok_or_else(math_error!())?;

                    margin_requirement = margin_requirement
                        .checked_add(weighted_token_value)
                        .ok_or_else(math_error!())?;

                    num_of_liabilities += 1;

                    if let Some(margin_buffer_ratio) = margin_buffer_ratio {
                        margin_requirement_plus_buffer = margin_requirement_plus_buffer
                            .checked_add(calculate_margin_requirement_with_buffer(
                                weighted_token_value,
                                token_amount,
                                margin_buffer_ratio,
                            )?)
                            .ok_or_else(math_error!())?;
                    }
                }
            }
        } else {
            let (worst_case_token_amount, worst_cast_quote_token_amount): (i128, i128) =
                spot_position.get_worst_case_token_amounts(
                    &spot_market,
                    oracle_price_data,
                    None,
                )?;
            let worst_case_token_value = get_token_value(
                worst_case_token_amount,
                spot_market.decimals,
                oracle_price_data,
            )?;

            match worst_case_token_amount.cmp(&0) {
                Ordering::Greater => {
                    let weighted_token_value = worst_case_token_value
                        .unsigned_abs()
                        .checked_mul(spot_market.get_asset_weight(
                            worst_case_token_amount.unsigned_abs(),
                            &margin_requirement_type,
                        )?)
                        .ok_or_else(math_error!())?
                        .checked_div(SPOT_WEIGHT_PRECISION)
                        .ok_or_else(math_error!())?;

                    total_collateral = total_collateral
                        .checked_add(cast_to_i128(weighted_token_value)?)
                        .ok_or_else(math_error!())?;
                }
                Ordering::Less => {
                    let liability_weight =
                        user_custom_margin_ratio.max(spot_market.get_liability_weight(
                            worst_case_token_amount.unsigned_abs(),
                            &margin_requirement_type,
                        )?);

                    let weighted_token_value = worst_case_token_value
                        .unsigned_abs()
                        .checked_mul(liability_weight)
                        .ok_or_else(math_error!())?
                        .checked_div(SPOT_WEIGHT_PRECISION)
                        .ok_or_else(math_error!())?;

                    margin_requirement = margin_requirement
                        .checked_add(weighted_token_value)
                        .ok_or_else(math_error!())?;

                    if let Some(margin_buffer_ratio) = margin_buffer_ratio {
                        margin_requirement_plus_buffer = margin_requirement_plus_buffer
                            .checked_add(calculate_margin_requirement_with_buffer(
                                weighted_token_value,
                                worst_case_token_value.unsigned_abs(),
                                margin_buffer_ratio,
                            )?)
                            .ok_or_else(math_error!())?;
                    }

                    num_of_liabilities += 1;
                    with_isolated_liability &= spot_market.asset_tier == AssetTier::Isolated;
                }
                Ordering::Equal => {}
            }

            match worst_cast_quote_token_amount.cmp(&0) {
                Ordering::Greater => {
                    total_collateral = total_collateral
                        .checked_add(cast_to_i128(worst_cast_quote_token_amount)?)
                        .ok_or_else(math_error!())?
                }
                Ordering::Less => {
                    let liability_weight = user_custom_margin_ratio.max(SPOT_WEIGHT_PRECISION);
                    let weighted_token_value = worst_cast_quote_token_amount
                        .unsigned_abs()
                        .checked_mul(liability_weight)
                        .ok_or_else(math_error!())?
                        .checked_div(SPOT_WEIGHT_PRECISION)
                        .ok_or_else(math_error!())?;

                    margin_requirement = margin_requirement
                        .checked_add(weighted_token_value)
                        .ok_or_else(math_error!())?;

                    if let Some(margin_buffer_ratio) = margin_buffer_ratio {
                        margin_requirement_plus_buffer = margin_requirement_plus_buffer
                            .checked_add(calculate_margin_requirement_with_buffer(
                                weighted_token_value,
                                worst_cast_quote_token_amount.unsigned_abs(),
                                margin_buffer_ratio,
                            )?)
                            .ok_or_else(math_error!())?;
                    }
                }
                Ordering::Equal => {}
            }
        }
    }

    for market_position in user.perp_positions.iter() {
        if market_position.base_asset_amount == 0
            && market_position.quote_asset_amount == 0
            && !market_position.has_open_order()
            && !market_position.is_lp()
        {
            continue;
        }

        let market = &perp_market_map.get_ref(&market_position.market_index)?;

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
                margin_requirement_type,
                user_custom_margin_ratio,
            )?;

        margin_requirement = margin_requirement
            .checked_add(perp_margin_requirement)
            .ok_or_else(math_error!())?;

        if let Some(margin_buffer_ratio) = margin_buffer_ratio {
            margin_requirement_plus_buffer = margin_requirement_plus_buffer
                .checked_add(calculate_margin_requirement_with_buffer(
                    perp_margin_requirement,
                    worst_case_base_asset_value,
                    margin_buffer_ratio,
                )?)
                .ok_or_else(math_error!())?;
        }

        total_collateral = total_collateral
            .checked_add(weighted_pnl)
            .ok_or_else(math_error!())?;

        num_of_liabilities += 1;
    }

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
) -> ClearingHouseResult<(u128, i128, u128, bool)> {
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
) -> ClearingHouseResult<bool> {
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
        MarginRequirementType::Initial,
        spot_market_map,
        oracle_map,
        None,
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
            ErrorCode::DefaultError,
            "User attempting to increase number of liabilities above 1 with a isolated tier liability"
        )?;
    }

    validate!(
        total_collateral >= cast_to_i128(initial_margin_requirement)?,
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
) -> ClearingHouseResult<u128> {
    margin_requirement
        .checked_add(
            liability_value
                .checked_mul(buffer_ratio)
                .ok_or_else(math_error!())?
                / MARGIN_PRECISION,
        )
        .ok_or_else(math_error!())
}

pub fn meets_place_order_margin_requirement(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    risk_decreasing: bool,
) -> ClearingHouseResult<bool> {
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
    )?;

    let meets_initial_margin_requirement = total_collateral >= cast_to_i128(margin_requirement)?;

    if !meets_initial_margin_requirement && !risk_decreasing {
        return Err(ErrorCode::InsufficientCollateral);
    }

    if num_of_liabilities > 1 {
        validate!(
            !includes_isolated_liability,
            ErrorCode::DefaultError,
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
) -> ClearingHouseResult<bool> {
    let (margin_requirement, total_collateral, _, _) =
        calculate_margin_requirement_and_total_collateral(
            user,
            perp_market_map,
            MarginRequirementType::Initial,
            spot_market_map,
            oracle_map,
            None,
        )?;
    Ok(total_collateral >= cast_to_i128(margin_requirement)?)
}

pub fn meets_maintenance_margin_requirement(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> ClearingHouseResult<bool> {
    let (margin_requirement, total_collateral, _, _) =
        calculate_margin_requirement_and_total_collateral(
            user,
            perp_market_map,
            MarginRequirementType::Maintenance,
            spot_market_map,
            oracle_map,
            None,
        )?;

    Ok(total_collateral >= cast_to_i128(margin_requirement)?)
}

pub fn calculate_free_collateral(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> ClearingHouseResult<i128> {
    let (margin_requirement, total_collateral, _, _) =
        calculate_margin_requirement_and_total_collateral(
            user,
            perp_market_map,
            MarginRequirementType::Initial,
            spot_market_map,
            oracle_map,
            None,
        )?;

    total_collateral
        .checked_sub(cast_to_i128(margin_requirement)?)
        .ok_or_else(math_error!())
}
