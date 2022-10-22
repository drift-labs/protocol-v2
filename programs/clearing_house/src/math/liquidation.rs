use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_RESERVE_PRECISION_I128, FUNDING_RATE_TO_QUOTE_PRECISION_PRECISION_RATIO,
    LIQUIDATION_FEE_PRECISION, LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO, PRICE_PRECISION,
    PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO, QUOTE_PRECISION, SPOT_WEIGHT_PRECISION,
};
use crate::math::margin::{
    calculate_margin_requirement_and_total_collateral, MarginRequirementType,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;

use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::PerpMarket;
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::user::User;
use crate::validate;
use solana_program::msg;

#[cfg(test)]
mod tests;

pub fn calculate_base_asset_amount_to_cover_margin_shortage(
    margin_shortage: u128,
    margin_ratio: u32,
    liquidation_fee: u128,
    if_liquidation_fee: u128,
    oracle_price: i128,
) -> ClearingHouseResult<u64> {
    let margin_ratio =
        (margin_ratio as u128).safe_mul(LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO)?;

    if oracle_price == 0 || margin_ratio <= liquidation_fee {
        return Ok(u64::MAX);
    }

    margin_shortage
        .safe_mul(PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO)?
        .safe_div(
            oracle_price
                .unsigned_abs()
                .safe_mul(margin_ratio.safe_sub(liquidation_fee)?)?
                .safe_div(LIQUIDATION_FEE_PRECISION)?
                .safe_sub(
                    oracle_price
                        .unsigned_abs()
                        .safe_mul(if_liquidation_fee)?
                        .safe_div(LIQUIDATION_FEE_PRECISION)?,
                )?,
        )?
        .cast()
}

pub fn calculate_liability_transfer_to_cover_margin_shortage(
    margin_shortage: u128,
    asset_weight: u128,
    asset_liquidation_multiplier: u128,
    liability_weight: u128,
    liability_liquidation_multiplier: u128,
    liability_decimals: u8,
    liability_price: i128,
    if_liquidation_fee: u128,
) -> ClearingHouseResult<u128> {
    // If unsettled pnl asset weight is 1 and quote asset is 1, this calculation breaks
    if asset_weight == liability_weight && asset_weight >= liability_weight {
        return Ok(u128::MAX);
    }

    let (numerator_scale, denominator_scale) = if liability_decimals > 6 {
        (10_u128.pow((liability_decimals - 6) as u32), 1)
    } else {
        (1, 10_u128.pow((6 - liability_decimals) as u32))
    };

    margin_shortage
        .safe_mul(numerator_scale)?
        .safe_mul(PRICE_PRECISION * SPOT_WEIGHT_PRECISION * 10)?
        .safe_div(
            liability_price
                .unsigned_abs()
                .safe_mul(
                    liability_weight
                        .safe_mul(10)? // multiply market weights by extra 10 to increase precision
                        .safe_sub(
                            asset_weight
                                .safe_mul(10)?
                                .safe_mul(asset_liquidation_multiplier)?
                                .safe_div(liability_liquidation_multiplier)?,
                        )?,
                )?
                .safe_sub(
                    liability_price
                        .unsigned_abs()
                        .safe_mul(if_liquidation_fee)?
                        .safe_div(LIQUIDATION_FEE_PRECISION)?
                        .safe_mul(liability_weight)?
                        .safe_mul(10)?,
                )?,
        )?
        .safe_div(denominator_scale)
}

pub fn calculate_liability_transfer_implied_by_asset_amount(
    asset_amount: u128,
    asset_liquidation_multiplier: u128,
    asset_decimals: u8,
    asset_price: i128,
    liability_liquidation_multiplier: u128,
    liability_decimals: u8,
    liability_price: i128,
) -> ClearingHouseResult<u128> {
    let (numerator_scale, denominator_scale) = if liability_decimals > asset_decimals {
        (10_u128.pow((liability_decimals - asset_decimals) as u32), 1)
    } else {
        (1, 10_u128.pow((asset_decimals - liability_decimals) as u32))
    };

    asset_amount
        .safe_mul(numerator_scale)?
        .safe_mul(asset_price.unsigned_abs())?
        .safe_mul(liability_liquidation_multiplier)?
        .safe_div(
            liability_price
                .unsigned_abs()
                .safe_mul(asset_liquidation_multiplier)?,
        )?
        .safe_div(denominator_scale)
}

pub fn calculate_asset_transfer_for_liability_transfer(
    asset_amount: u128,
    asset_liquidation_multiplier: u128,
    asset_decimals: u8,
    asset_price: i128,
    liability_amount: u128,
    liability_liquidation_multiplier: u128,
    liability_decimals: u8,
    liability_price: i128,
) -> ClearingHouseResult<u128> {
    let (numerator_scale, denominator_scale) = if asset_decimals > liability_decimals {
        (10_u128.pow((asset_decimals - liability_decimals) as u32), 1)
    } else {
        (1, 10_u128.pow((liability_decimals - asset_decimals) as u32))
    };

    let mut asset_transfer = liability_amount
        .safe_mul(numerator_scale)?
        .safe_mul(liability_price.unsigned_abs())?
        .safe_mul(asset_liquidation_multiplier)?
        .safe_div(
            asset_price
                .unsigned_abs()
                .safe_mul(liability_liquidation_multiplier)?,
        )?
        .safe_div(denominator_scale)?;

    // Need to check if asset_transfer should be rounded to asset amount
    let (asset_value_numerator_scale, asset_value_denominator_scale) = if asset_decimals > 6 {
        (10_u128.pow((asset_decimals - 6) as u32), 1)
    } else {
        (1, 10_u128.pow((asset_decimals - 6) as u32))
    };

    let asset_delta = if asset_transfer > asset_amount {
        asset_transfer - asset_amount
    } else {
        asset_amount - asset_transfer
    };

    let asset_value_delta = asset_delta
        .safe_mul(asset_price.unsigned_abs())?
        .safe_div(PRICE_PRECISION)?
        .safe_mul(asset_value_numerator_scale)?
        .safe_div(asset_value_denominator_scale)?;

    if asset_value_delta < QUOTE_PRECISION {
        asset_transfer = asset_amount;
    }

    Ok(asset_transfer)
}

pub fn is_user_being_liquidated(
    user: &User,
    market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    liquidation_margin_buffer_ratio: u32,
) -> ClearingHouseResult<bool> {
    let (_, total_collateral, margin_requirement_plus_buffer, _) =
        calculate_margin_requirement_and_total_collateral(
            user,
            market_map,
            MarginRequirementType::Maintenance,
            spot_market_map,
            oracle_map,
            Some(liquidation_margin_buffer_ratio as u128),
        )?;
    let is_being_liquidated = total_collateral <= margin_requirement_plus_buffer.cast()?;

    Ok(is_being_liquidated)
}

pub fn get_margin_requirement_plus_buffer(
    margin_requirement: u128,
    liquidation_margin_buffer_ratio: u8,
) -> ClearingHouseResult<u128> {
    margin_requirement
        .safe_add(margin_requirement.safe_div(liquidation_margin_buffer_ratio as u128)?)
}

pub fn validate_user_not_being_liquidated(
    user: &mut User,
    market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    liquidation_margin_buffer_ratio: u32,
) -> ClearingHouseResult {
    if !user.is_being_liquidated {
        return Ok(());
    }

    let is_still_being_liquidated = is_user_being_liquidated(
        user,
        market_map,
        spot_market_map,
        oracle_map,
        liquidation_margin_buffer_ratio,
    )?;

    if is_still_being_liquidated {
        return Err(ErrorCode::UserIsBeingLiquidated);
    } else {
        user.is_being_liquidated = false;
    }

    Ok(())
}

pub enum LiquidationMultiplierType {
    Discount,
    Premium,
}

pub fn calculate_liquidation_multiplier(
    liquidation_fee: u128,
    multiplier_type: LiquidationMultiplierType,
) -> ClearingHouseResult<u128> {
    match multiplier_type {
        LiquidationMultiplierType::Premium => LIQUIDATION_FEE_PRECISION.safe_add(liquidation_fee),
        LiquidationMultiplierType::Discount => LIQUIDATION_FEE_PRECISION.safe_sub(liquidation_fee),
    }
}

pub fn calculate_funding_rate_deltas_to_resolve_bankruptcy(
    loss: i128,
    market: &PerpMarket,
) -> ClearingHouseResult<i128> {
    let total_base_asset_amount = market
        .amm
        .base_asset_amount_long
        .abs()
        .safe_add(market.amm.base_asset_amount_short.abs())?;

    validate!(
        total_base_asset_amount != 0,
        ErrorCode::CantResolvePerpBankruptcy,
        "Cant resolve perp bankruptcy when total base asset amount is 0"
    )?;

    loss.abs()
        .safe_mul(AMM_RESERVE_PRECISION_I128)?
        .safe_div(total_base_asset_amount)?
        .safe_mul(FUNDING_RATE_TO_QUOTE_PRECISION_PRECISION_RATIO.cast()?)
}

pub fn calculate_cumulative_deposit_interest_delta_to_resolve_bankruptcy(
    borrow: u128,
    spot_market: &SpotMarket,
) -> ClearingHouseResult<u128> {
    let total_deposits = get_token_amount(
        spot_market.deposit_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?;

    spot_market
        .cumulative_deposit_interest
        .safe_mul(borrow)?
        .safe_div(total_deposits)
        .or(Ok(0))
}
