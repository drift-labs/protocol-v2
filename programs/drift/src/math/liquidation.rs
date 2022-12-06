use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_RESERVE_PRECISION_I128, BASE_PRECISION_U64,
    FUNDING_RATE_TO_QUOTE_PRECISION_PRECISION_RATIO, LIQUIDATION_FEE_PRECISION,
    LIQUIDATION_FEE_PRECISION_U128, LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO,
    LIQUIDATION_PCT_PRECISION, MARGIN_PRECISION_U64, PRICE_PRECISION,
    PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO, QUOTE_PRECISION, SPOT_WEIGHT_PRECISION_U128,
};
use crate::math::margin::{
    calculate_margin_requirement_and_total_collateral, MarginRequirementType,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;

use crate::controller::position::PositionDirection;
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
    liquidation_fee: u32,
    if_liquidation_fee: u32,
    oracle_price: i64,
) -> DriftResult<u64> {
    let margin_ratio = margin_ratio.safe_mul(LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO)?;

    if oracle_price == 0 || margin_ratio <= liquidation_fee {
        return Ok(u64::MAX);
    }

    margin_shortage
        .safe_mul(PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO)?
        .safe_div(
            oracle_price
                .cast::<u128>()?
                .safe_mul(margin_ratio.safe_sub(liquidation_fee)?.cast()?)?
                .safe_div(LIQUIDATION_FEE_PRECISION_U128)?
                .safe_sub(
                    oracle_price
                        .cast::<u128>()?
                        .safe_mul(if_liquidation_fee.cast()?)?
                        .safe_div(LIQUIDATION_FEE_PRECISION_U128)?,
                )?,
        )?
        .cast()
}

pub fn calculate_liability_transfer_to_cover_margin_shortage(
    margin_shortage: u128,
    asset_weight: u32,
    asset_liquidation_multiplier: u32,
    liability_weight: u32,
    liability_liquidation_multiplier: u32,
    liability_decimals: u32,
    liability_price: i64,
    if_liquidation_fee: u32,
) -> DriftResult<u128> {
    // If unsettled pnl asset weight is 1 and quote asset is 1, this calculation breaks
    if asset_weight == liability_weight && asset_weight >= liability_weight {
        return Ok(u128::MAX);
    }

    let (numerator_scale, denominator_scale) = if liability_decimals > 6 {
        (10_u128.pow(liability_decimals - 6), 1)
    } else {
        (1, 10_u128.pow(6 - liability_decimals))
    };

    margin_shortage
        .safe_mul(numerator_scale)?
        .safe_mul(PRICE_PRECISION * SPOT_WEIGHT_PRECISION_U128 * 10)?
        .safe_div(
            liability_price
                .cast::<u128>()?
                .safe_mul(
                    liability_weight
                        .cast::<u128>()?
                        .safe_mul(10)? // multiply market weights by extra 10 to increase precision
                        .safe_sub(
                            asset_weight
                                .cast::<u128>()?
                                .safe_mul(10)?
                                .safe_mul(asset_liquidation_multiplier.cast()?)?
                                .safe_div(liability_liquidation_multiplier.cast()?)?,
                        )?,
                )?
                .safe_sub(
                    liability_price
                        .cast::<u128>()?
                        .safe_mul(if_liquidation_fee.cast()?)?
                        .safe_div(LIQUIDATION_FEE_PRECISION_U128)?
                        .safe_mul(liability_weight.cast()?)?
                        .safe_mul(10)?,
                )?,
        )?
        .safe_div(denominator_scale)
}

pub fn calculate_liability_transfer_implied_by_asset_amount(
    asset_amount: u128,
    asset_liquidation_multiplier: u32,
    asset_decimals: u32,
    asset_price: i64,
    liability_liquidation_multiplier: u32,
    liability_decimals: u32,
    liability_price: i64,
) -> DriftResult<u128> {
    let (numerator_scale, denominator_scale) = if liability_decimals > asset_decimals {
        (10_u128.pow(liability_decimals - asset_decimals), 1)
    } else {
        (1, 10_u128.pow(asset_decimals - liability_decimals))
    };

    asset_amount
        .safe_mul(numerator_scale)?
        .safe_mul(asset_price.cast()?)?
        .safe_mul(liability_liquidation_multiplier.cast()?)?
        .safe_div(
            liability_price
                .cast::<u128>()?
                .safe_mul(asset_liquidation_multiplier.cast()?)?,
        )?
        .safe_div(denominator_scale)
}

pub fn calculate_asset_transfer_for_liability_transfer(
    asset_amount: u128,
    asset_liquidation_multiplier: u32,
    asset_decimals: u32,
    asset_price: i64,
    liability_amount: u128,
    liability_liquidation_multiplier: u32,
    liability_decimals: u32,
    liability_price: i64,
) -> DriftResult<u128> {
    let (numerator_scale, denominator_scale) = if asset_decimals > liability_decimals {
        (10_u128.pow(asset_decimals - liability_decimals), 1)
    } else {
        (1, 10_u128.pow(liability_decimals - asset_decimals))
    };

    let mut asset_transfer = liability_amount
        .safe_mul(numerator_scale)?
        .safe_mul(liability_price.cast()?)?
        .safe_mul(asset_liquidation_multiplier.cast()?)?
        .safe_div(
            asset_price
                .cast::<u128>()?
                .safe_mul(liability_liquidation_multiplier.cast()?)?,
        )?
        .safe_div(denominator_scale)?;

    // Need to check if asset_transfer should be rounded to asset amount
    let (asset_value_numerator_scale, asset_value_denominator_scale) = if asset_decimals > 6 {
        (10_u128.pow(asset_decimals - 6), 1)
    } else {
        (1, 10_u128.pow(asset_decimals - 6))
    };

    let asset_delta = if asset_transfer > asset_amount {
        asset_transfer - asset_amount
    } else {
        asset_amount - asset_transfer
    };

    let asset_value_delta = asset_delta
        .safe_mul(asset_price.cast()?)?
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
) -> DriftResult<bool> {
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
) -> DriftResult<u128> {
    margin_requirement
        .safe_add(margin_requirement.safe_div(liquidation_margin_buffer_ratio as u128)?)
}

pub fn validate_user_not_being_liquidated(
    user: &mut User,
    market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    liquidation_margin_buffer_ratio: u32,
) -> DriftResult {
    if !user.is_being_liquidated() {
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
        user.exit_liquidation()
    }

    Ok(())
}

pub enum LiquidationMultiplierType {
    Discount,
    Premium,
}

pub fn calculate_liquidation_multiplier(
    liquidation_fee: u32,
    multiplier_type: LiquidationMultiplierType,
) -> DriftResult<u32> {
    match multiplier_type {
        LiquidationMultiplierType::Premium => LIQUIDATION_FEE_PRECISION.safe_add(liquidation_fee),
        LiquidationMultiplierType::Discount => LIQUIDATION_FEE_PRECISION.safe_sub(liquidation_fee),
    }
}

pub fn calculate_funding_rate_deltas_to_resolve_bankruptcy(
    loss: i128,
    market: &PerpMarket,
) -> DriftResult<i128> {
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
        .safe_div_ceil(total_base_asset_amount)?
        .safe_mul(FUNDING_RATE_TO_QUOTE_PRECISION_PRECISION_RATIO.cast()?)
}

pub fn calculate_cumulative_deposit_interest_delta_to_resolve_bankruptcy(
    borrow: u128,
    spot_market: &SpotMarket,
) -> DriftResult<u128> {
    let total_deposits = get_token_amount(
        spot_market.deposit_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?;

    spot_market
        .cumulative_deposit_interest
        .safe_mul(borrow)?
        .safe_div_ceil(total_deposits)
        .or(Ok(0))
}

pub fn validate_transfer_satisfies_limit_price(
    asset_transfer: u128,
    liability_transfer: u128,
    asset_decimals: u32,
    liability_decimals: u32,
    limit_price: Option<u64>,
) -> DriftResult {
    let limit_price = match limit_price {
        Some(limit_price) => limit_price,
        None => return Ok(()),
    };

    let transfer_price = asset_transfer
        .safe_mul(PRICE_PRECISION)?
        .safe_div(10_u128.pow(asset_decimals))?
        .safe_mul(10_u128.pow(liability_decimals))?
        .safe_div(liability_transfer)?;

    validate!(
        transfer_price >= limit_price.cast()?,
        ErrorCode::LiquidationDoesntSatisfyLimitPrice,
        "transfer price transfer_price ({}/1000000) < limit price ({}/1000000)",
        transfer_price,
        limit_price
    )
}

pub fn calculate_margin_shortage(
    margin_requirement_with_buffer: u128,
    total_collateral: i128,
) -> DriftResult<u128> {
    Ok(margin_requirement_with_buffer
        .cast::<i128>()?
        .safe_sub(total_collateral)?
        .unsigned_abs())
}

pub fn calculate_max_pct_to_liquidate(
    user: &User,
    margin_shortage: u128,
    slot: u64,
    initial_pct_to_liquidate: u128,
    liquidation_duration: u128,
) -> DriftResult<u128> {
    let slots_elapsed = slot.safe_sub(user.liquidation_start_slot)?;

    let pct_freeable = slots_elapsed
        .cast::<u128>()?
        .safe_mul(LIQUIDATION_PCT_PRECISION)?
        .safe_div(liquidation_duration) // ~ 1 minute if per slot is 400ms
        .unwrap_or(LIQUIDATION_PCT_PRECISION) // if divide by zero, default to 100%
        .safe_add(initial_pct_to_liquidate)?
        .min(LIQUIDATION_PCT_PRECISION);

    let total_margin_shortage = margin_shortage.safe_add(user.liquidation_margin_freed.cast()?)?;
    let max_margin_freed = total_margin_shortage
        .safe_mul(pct_freeable)?
        .safe_div(LIQUIDATION_PCT_PRECISION)?;
    let margin_freeable = max_margin_freed.saturating_sub(user.liquidation_margin_freed.cast()?);

    margin_freeable
        .safe_mul(LIQUIDATION_PCT_PRECISION)?
        .safe_div(margin_shortage)
}

pub fn calculate_margin_freed_by_perp_liquidation_order(
    direction: &PositionDirection,
    base_asset_amount: u64,
    quote_asset_amount: u64,
    margin_ratio: u32,
    oracle_price: i64,
    taker_fee: u64,
) -> DriftResult<u64> {
    let base_asset_value = base_asset_amount
        .safe_mul(oracle_price.cast()?)?
        .safe_div(BASE_PRECISION_U64)?;

    let margin_requirement_reduced = base_asset_value
        .safe_mul(margin_ratio.cast()?)?
        .safe_div(MARGIN_PRECISION_U64)?;

    let pnl = match direction {
        PositionDirection::Long => quote_asset_amount
            .cast::<i64>()?
            .safe_sub(base_asset_value.cast()?)?,
        PositionDirection::Short => base_asset_value
            .cast::<i64>()?
            .safe_sub(quote_asset_amount.cast()?)?,
    };

    margin_requirement_reduced
        .cast::<i64>()?
        .safe_add(pnl)?
        .safe_sub(taker_fee.cast()?)?
        .max(0)
        .cast()
}
