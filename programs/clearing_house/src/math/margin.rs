use crate::error::ClearingHouseResult;
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO_I128, BID_ASK_SPREAD_PRECISION_I128, MARGIN_PRECISION,
    SPOT_IMF_PRECISION, SPOT_WEIGHT_PRECISION,
};
use crate::math::position::{
    calculate_base_asset_value_and_pnl_with_oracle_price,
    calculate_base_asset_value_with_oracle_price,
};
use crate::math_error;

use crate::state::user::User;

use crate::math::casting::cast_to_i128;
use crate::math::funding::calculate_funding_payment;
use crate::math::lp::{calculate_lp_open_bids_asks, calculate_settle_lp_metrics};
use crate::math::spot_balance::{
    get_balance_value_and_token_amount, get_token_amount, get_token_value,
};
use crate::state::market::PerpMarket;
use crate::state::oracle::OraclePriceData;
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::user::{PerpPosition, SpotPosition};
use num_integer::Roots;
use solana_program::msg;
use std::cmp::{max, min};

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

    let size_sqrt = ((size / 1000) + 1).nth_root(2); //1e13 -> 1e10 -> 1e5

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

    let size_sqrt = ((size / 1000) + 1).nth_root(2); //1e13 -> 1e10 -> 1e5
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

pub fn calculate_oracle_price_for_perp_margin(
    market_position: &PerpPosition,
    market: &PerpMarket,
    oracle_price_data: &OraclePriceData,
) -> ClearingHouseResult<i128> {
    let oracle_price_offset = min(
        (market.amm.max_spread as i128)
            .checked_mul(oracle_price_data.price)
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION_I128)
            .ok_or_else(math_error!())?,
        cast_to_i128(oracle_price_data.confidence)?
            .checked_add(
                (market.amm.base_spread as i128)
                    .checked_mul(oracle_price_data.price)
                    .ok_or_else(math_error!())?
                    .checked_div(BID_ASK_SPREAD_PRECISION_I128)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?,
    );
    let oracle_price = if market_position.base_asset_amount > 0 {
        oracle_price_data
            .price
            .checked_sub(oracle_price_offset)
            .ok_or_else(math_error!())?
    } else {
        oracle_price_data
            .price
            .checked_add(oracle_price_offset)
            .ok_or_else(math_error!())?
    };

    Ok(oracle_price)
}

pub fn calculate_perp_position_value_and_pnl(
    market_position: &PerpPosition,
    market: &PerpMarket,
    oracle_price_data: &OraclePriceData,
    margin_requirement_type: MarginRequirementType,
) -> ClearingHouseResult<(u128, i128)> {
    let unrealized_funding = calculate_funding_payment(
        if market_position.base_asset_amount > 0 {
            market.amm.cumulative_funding_rate_long
        } else {
            market.amm.cumulative_funding_rate_short
        },
        market_position,
    )?
    .checked_div(AMM_TO_QUOTE_PRECISION_RATIO_I128)
    .ok_or_else(math_error!())?;

    let market_position = if market_position.is_lp() {
        // compute lp metrics
        let lp_metrics = calculate_settle_lp_metrics(&market.amm, market_position)?;

        // compute settled position
        let base_asset_amount = market_position
            .base_asset_amount
            .checked_add(lp_metrics.base_asset_amount)
            .ok_or_else(math_error!())?;

        let mut quote_asset_amount = market_position
            .quote_asset_amount
            .checked_add(lp_metrics.quote_asset_amount)
            .ok_or_else(math_error!())?;

        // dust position in baa/qaa
        if lp_metrics.remainder_base_asset_amount != 0 {
            let dust_base_asset_value = calculate_base_asset_value_with_oracle_price(
                lp_metrics.remainder_base_asset_amount,
                oracle_price_data.price,
            )?
            .checked_add(1)
            .ok_or_else(math_error!())?;

            quote_asset_amount = quote_asset_amount
                .checked_sub(cast_to_i128(dust_base_asset_value)?)
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
            // this is ok because no other values are used in the future computations
            ..PerpPosition::default()
        }
    } else {
        *market_position
    };

    let (_, unrealized_pnl) = calculate_base_asset_value_and_pnl_with_oracle_price(
        &market_position,
        oracle_price_data.price,
    )?;

    let total_unrealized_pnl = unrealized_funding
        .checked_add(unrealized_pnl)
        .ok_or_else(math_error!())?;

    let worst_case_base_asset_amount = market_position.worst_case_base_asset_amount()?;

    let worse_case_base_asset_value = calculate_base_asset_value_with_oracle_price(
        worst_case_base_asset_amount,
        oracle_price_data.price,
    )?;

    let margin_ratio = market.get_margin_ratio(
        worst_case_base_asset_amount.unsigned_abs(),
        margin_requirement_type,
    )?;

    let margin_requirement = worse_case_base_asset_value
        .checked_mul(margin_ratio.into())
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

    Ok((margin_requirement, weighted_unrealized_pnl))
}

pub fn calculate_margin_requirement_and_total_collateral(
    user: &User,
    perp_market_map: &PerpMarketMap,
    margin_requirement_type: MarginRequirementType,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> ClearingHouseResult<(u128, i128)> {
    let mut total_collateral: i128 = 0;
    let mut margin_requirement: u128 = 0;

    for spot_position in user.spot_positions.iter() {
        if spot_position.balance == 0 && spot_position.open_orders == 0 {
            continue;
        }

        let spot_market = spot_market_map.get_ref(&spot_position.market_index)?;
        let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle)?;
        if spot_market.market_index == 0 {
            let token_amount = get_token_amount(
                spot_position.balance,
                &spot_market,
                &spot_position.balance_type,
            )?;

            match spot_position.balance_type {
                SpotBalanceType::Deposit => {
                    total_collateral = total_collateral
                        .checked_add(cast_to_i128(token_amount)?)
                        .ok_or_else(math_error!())?
                }
                SpotBalanceType::Borrow => {
                    margin_requirement = margin_requirement
                        .checked_add(token_amount)
                        .ok_or_else(math_error!())?
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

            match worst_case_token_amount > 0 {
                true => {
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
                false => {
                    let weighted_token_value = worst_case_token_value
                        .unsigned_abs()
                        .checked_mul(spot_market.get_liability_weight(
                            worst_case_token_amount.unsigned_abs(),
                            &margin_requirement_type,
                        )?)
                        .ok_or_else(math_error!())?
                        .checked_div(SPOT_WEIGHT_PRECISION)
                        .ok_or_else(math_error!())?;

                    margin_requirement = margin_requirement
                        .checked_add(weighted_token_value)
                        .ok_or_else(math_error!())?;
                }
            }

            match worst_cast_quote_token_amount > 0 {
                true => {
                    total_collateral = total_collateral
                        .checked_add(cast_to_i128(worst_cast_quote_token_amount)?)
                        .ok_or_else(math_error!())?
                }
                false => {
                    margin_requirement = margin_requirement
                        .checked_add(worst_cast_quote_token_amount.unsigned_abs())
                        .ok_or_else(math_error!())?
                }
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

        let oracle_price_data = oracle_map.get_price_data(&market.amm.oracle)?;

        let (perp_margin_requirement, weighted_pnl) = calculate_perp_position_value_and_pnl(
            market_position,
            market,
            oracle_price_data,
            margin_requirement_type,
        )?;

        margin_requirement = margin_requirement
            .checked_add(perp_margin_requirement)
            .ok_or_else(math_error!())?;

        total_collateral = total_collateral
            .checked_add(weighted_pnl)
            .ok_or_else(math_error!())?;
    }

    Ok((margin_requirement, total_collateral))
}

pub fn calculate_net_quote_balance(
    user: &User,
    margin_requirement_type: MarginRequirementType,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> ClearingHouseResult<i128> {
    let mut net_quote_balance: i128 = 0;

    for spot_position in user.spot_positions.iter() {
        if spot_position.balance == 0 {
            continue;
        }

        let spot_market = &spot_market_map.get_ref(&spot_position.market_index)?;

        let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle)?;
        let (balance_value, token_amount) =
            get_balance_value_and_token_amount(spot_position, spot_market, oracle_price_data)?;

        match spot_position.balance_type {
            SpotBalanceType::Deposit => {
                net_quote_balance = net_quote_balance
                    .checked_add(cast_to_i128(
                        balance_value
                            .checked_mul(
                                spot_market
                                    .get_asset_weight(token_amount, &margin_requirement_type)?,
                            )
                            .ok_or_else(math_error!())?
                            .checked_div(SPOT_WEIGHT_PRECISION)
                            .ok_or_else(math_error!())?,
                    )?)
                    .ok_or_else(math_error!())?;
            }
            SpotBalanceType::Borrow => {
                net_quote_balance = net_quote_balance
                    .checked_sub(cast_to_i128(
                        balance_value
                            .checked_mul(
                                spot_market
                                    .get_liability_weight(token_amount, &margin_requirement_type)?,
                            )
                            .ok_or_else(math_error!())?
                            .checked_div(SPOT_WEIGHT_PRECISION)
                            .ok_or_else(math_error!())?,
                    )?)
                    .ok_or_else(math_error!())?;
            }
        }
    }

    Ok(net_quote_balance)
}

pub fn meets_initial_margin_requirement(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> ClearingHouseResult<bool> {
    let (margin_requirement, total_collateral) = calculate_margin_requirement_and_total_collateral(
        user,
        perp_market_map,
        MarginRequirementType::Initial,
        spot_market_map,
        oracle_map,
    )?;
    Ok(total_collateral >= cast_to_i128(margin_requirement)?)
}

pub fn meets_maintenance_margin_requirement(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> ClearingHouseResult<bool> {
    let (margin_requirement, total_collateral) = calculate_margin_requirement_and_total_collateral(
        user,
        perp_market_map,
        MarginRequirementType::Maintenance,
        spot_market_map,
        oracle_map,
    )?;

    Ok(total_collateral >= cast_to_i128(margin_requirement)?)
}

pub fn calculate_free_collateral(
    user: &User,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> ClearingHouseResult<i128> {
    let (margin_requirement, total_collateral) = calculate_margin_requirement_and_total_collateral(
        user,
        perp_market_map,
        MarginRequirementType::Initial,
        spot_market_map,
        oracle_map,
    )?;

    total_collateral
        .checked_sub(cast_to_i128(margin_requirement)?)
        .ok_or_else(math_error!())
}
