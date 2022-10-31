use crate::error::{DriftResult, ErrorCode};
use crate::math::amm::calculate_net_user_cost_basis;
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_RESERVE_PRECISION_I128, BASE_PRECISION_I128,
    FUNDING_RATE_TO_QUOTE_PRECISION_PRECISION_RATIO, LIQUIDATION_FEE_PRECISION,
    LIQUIDATION_FEE_PRECISION_U128, LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO, PRICE_PRECISION,
    PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO, PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128,
    QUOTE_PRECISION, SPOT_WEIGHT_PRECISION_U128,
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

use super::constants::PRICE_TO_QUOTE_PRECISION_RATIO;

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
        .safe_div(total_base_asset_amount)?
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
        .safe_div(total_deposits)
        .or(Ok(0))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeleverageUserStats {
    pub base_asset_amount: i64,
    pub quote_asset_amount: i64,
    pub quote_break_even_amount: i64,
    pub free_collateral: i128,
}

pub fn calculate_perp_market_deleverage_payment(
    loss_to_socialize: i128,
    deleverage_user_stats: DeleverageUserStats,
    market: &PerpMarket,
    oracle_price: i64,
) -> DriftResult<i128> {
    validate!(
        market.number_of_users > 0,
        ErrorCode::InvalidAmmDetected,
        "Market in corrupted state"
    )?;

    let mean_short_price_per_base = if market.amm.base_asset_amount_short != 0 {
        market
            .amm
            .quote_break_even_amount_short
            .safe_mul(BASE_PRECISION_I128)?
            .safe_div(market.amm.base_asset_amount_short)?
    } else {
        0
    };

    let mean_short_pnl_per_base = mean_short_price_per_base
        .safe_sub(oracle_price.cast()?)?
        .safe_div(PRICE_TO_QUOTE_PRECISION_RATIO.cast()?)?;

    let mean_long_price_per_base = if market.amm.base_asset_amount_long != 0 {
        market
            .amm
            .quote_break_even_amount_long
            .safe_mul(PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128)?
            .safe_div(market.amm.base_asset_amount_long)?
    } else {
        0
    };

    let mean_long_pnl_per_base = mean_long_price_per_base
        .safe_add(oracle_price.cast()?)?
        .safe_div(PRICE_TO_QUOTE_PRECISION_RATIO.cast()?)?;

    let mean_entry_price_per_base: i128 = if deleverage_user_stats.base_asset_amount > 0 {
        mean_long_price_per_base
    } else if deleverage_user_stats.base_asset_amount < 0 {
        mean_short_price_per_base
    } else {
        0
    };

    let user_entry_price_per_base: i128 = if deleverage_user_stats.base_asset_amount != 0 {
        BASE_PRECISION_I128
            .safe_mul(deleverage_user_stats.quote_break_even_amount.cast()?)?
            .safe_div(deleverage_user_stats.base_asset_amount.cast()?)?
    } else {
        0
    };

    let exit_price_per_base = oracle_price
        .safe_mul(deleverage_user_stats.base_asset_amount.signum().cast()?)?
        .safe_div(PRICE_TO_QUOTE_PRECISION_RATIO.cast()?)?;

    let mean_pnl_per_base = mean_entry_price_per_base.safe_add(exit_price_per_base.cast()?)?;
    let user_pnl_per_base = user_entry_price_per_base.safe_add(exit_price_per_base.cast()?)?;

    let profit_above_mean = if deleverage_user_stats.base_asset_amount == 0 {
        msg!("user has no base");
        if deleverage_user_stats.quote_asset_amount != 0 {
            let mean_quote = (market.amm.base_asset_amount_short)
                .safe_add(market.amm.base_asset_amount_long)?
                .safe_mul(oracle_price.cast()?)?
                .safe_div(PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128)?
                .safe_add(calculate_net_user_cost_basis(&market.amm)?)?
                .safe_add(loss_to_socialize)?
                .safe_div(market.number_of_users.cast()?)?;

            -(mean_quote.safe_sub(deleverage_user_stats.quote_asset_amount.cast()?)?)
        } else {
            0
        }
    } else if user_pnl_per_base > mean_pnl_per_base && user_pnl_per_base > 0 {
        msg!(
            "user pays profit surplus, {} > {}",
            user_pnl_per_base,
            mean_pnl_per_base,
        );

        user_entry_price_per_base
            .safe_sub(mean_entry_price_per_base)?
            .safe_mul(deleverage_user_stats.base_asset_amount.cast()?)?
            .safe_div(BASE_PRECISION_I128)?
    } else if user_pnl_per_base == mean_pnl_per_base && user_pnl_per_base > 0 {
        msg!("user pays loss_to_socialize / N users");

        // more than 2, split
        if market.number_of_users > 2 {
            loss_to_socialize
                .abs()
                .safe_div(market.number_of_users.cast()?)?
                .max(1)
        } else {
            loss_to_socialize.abs()
        }
    } else if (mean_long_pnl_per_base > mean_short_pnl_per_base
        && deleverage_user_stats.base_asset_amount < 0)
        || (mean_long_pnl_per_base < mean_short_pnl_per_base
            && deleverage_user_stats.base_asset_amount > 0)
    {
        msg!("user on side that does not owe");
        0
    } else {
        msg!("user not above mean excess profit");
        0
    };

    // never let deleveraging put user into liquidation territory
    let max_user_payment = if deleverage_user_stats.base_asset_amount == 0 {
        deleverage_user_stats
            .quote_asset_amount
            .min(deleverage_user_stats.free_collateral.cast()?)
    } else {
        deleverage_user_stats.free_collateral.cast()?
    };

    let deleverage_payment = profit_above_mean
        .min(max_user_payment.cast()?)
        .min(-loss_to_socialize)
        .max(0);

    Ok(deleverage_payment)
}
