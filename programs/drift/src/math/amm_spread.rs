use std::cmp::{max, min};

use solana_program::msg;

use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::math::amm::_calculate_market_open_bids_asks;
use crate::math::bn::U192;
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO_I128, AMM_TO_QUOTE_PRECISION_RATIO_I128,
    BID_ASK_SPREAD_PRECISION, BID_ASK_SPREAD_PRECISION_I128, DEFAULT_LARGE_BID_ASK_FACTOR,
    DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT, FUNDING_RATE_BUFFER,
    MAX_BID_ASK_INVENTORY_SKEW_FACTOR, PEG_PRECISION, PERCENTAGE_PRECISION,
    PERCENTAGE_PRECISION_I128, PERCENTAGE_PRECISION_U64, PRICE_PRECISION, PRICE_PRECISION_I128,
    PRICE_PRECISION_I64,
};
use crate::math::safe_math::SafeMath;

use crate::state::perp_market::AMM;
use crate::validate;

#[cfg(test)]
mod tests;

pub fn calculate_base_asset_amount_to_trade_to_price(
    amm: &AMM,
    limit_price: u64,
    direction: PositionDirection,
) -> DriftResult<(u64, PositionDirection)> {
    let invariant_sqrt_u192 = U192::from(amm.sqrt_k);
    let invariant = invariant_sqrt_u192.safe_mul(invariant_sqrt_u192)?;

    validate!(
        limit_price > 0,
        ErrorCode::InvalidOrderLimitPrice,
        "limit_price <= 0"
    )?;

    let new_base_asset_reserve_squared = invariant
        .safe_mul(U192::from(PRICE_PRECISION))?
        .safe_div(U192::from(limit_price))?
        .safe_mul(U192::from(amm.peg_multiplier))?
        .safe_div(U192::from(PEG_PRECISION))?;

    let new_base_asset_reserve = new_base_asset_reserve_squared
        .integer_sqrt()
        .try_to_u128()?;

    let base_asset_reserve_before = if amm.base_spread > 0 {
        let (spread_base_asset_reserve, _) = get_spread_reserves(amm, direction)?;
        spread_base_asset_reserve
    } else {
        amm.base_asset_reserve
    };

    if new_base_asset_reserve > base_asset_reserve_before {
        let max_trade_amount = new_base_asset_reserve
            .safe_sub(base_asset_reserve_before)?
            .cast::<u64>()
            .unwrap_or(u64::MAX);
        Ok((max_trade_amount, PositionDirection::Short))
    } else {
        let max_trade_amount = base_asset_reserve_before
            .safe_sub(new_base_asset_reserve)?
            .cast::<u64>()
            .unwrap_or(u64::MAX);
        Ok((max_trade_amount, PositionDirection::Long))
    }
}

pub fn cap_to_max_spread(
    mut long_spread: u64,
    mut short_spread: u64,
    max_spread: u64,
) -> DriftResult<(u64, u64)> {
    let total_spread = long_spread.safe_add(short_spread)?;

    if total_spread > max_spread {
        if long_spread > short_spread {
            long_spread = long_spread
                .safe_mul(max_spread)?
                .safe_div_ceil(total_spread)?;
            short_spread = max_spread.safe_sub(long_spread)?;
        } else {
            short_spread = short_spread
                .safe_mul(max_spread)?
                .safe_div_ceil(total_spread)?;
            long_spread = max_spread.safe_sub(short_spread)?;
        }
    }

    let new_total_spread = long_spread.safe_add(short_spread)?;

    validate!(
        new_total_spread <= max_spread,
        ErrorCode::InvalidAmmMaxSpreadDetected,
        "new_total_spread({}) > max_spread({})",
        new_total_spread,
        max_spread
    )?;

    Ok((long_spread, short_spread))
}

pub fn calculate_long_short_vol_spread(
    last_oracle_conf_pct: u64,
    reserve_price: u64,
    mark_std: u64,
    oracle_std: u64,
    long_intensity_volume: u64,
    short_intensity_volume: u64,
    volume_24h: u64,
) -> DriftResult<(u64, u64)> {
    // 1.6 * std
    let market_avg_std_pct: u128 = oracle_std
        .safe_add(mark_std)?
        .cast::<u128>()?
        .safe_mul(PERCENTAGE_PRECISION)?
        .safe_div(reserve_price.cast::<u128>()?)?
        .safe_div(2)?;

    let vol_spread: u128 = last_oracle_conf_pct
        .cast::<u128>()?
        .max(market_avg_std_pct.safe_div(2)?);

    let factor_clamp_min: u128 = PERCENTAGE_PRECISION / 100; // .01
    let factor_clamp_max: u128 = 16 * PERCENTAGE_PRECISION / 10; // 1.6

    let long_vol_spread_factor: u128 = long_intensity_volume
        .cast::<u128>()?
        .safe_mul(PERCENTAGE_PRECISION)?
        .safe_div(max(volume_24h.cast::<u128>()?, 1))?
        .clamp(factor_clamp_min, factor_clamp_max);
    let short_vol_spread_factor: u128 = short_intensity_volume
        .cast::<u128>()?
        .safe_mul(PERCENTAGE_PRECISION)?
        .safe_div(max(volume_24h.cast::<u128>()?, 1))?
        .clamp(factor_clamp_min, factor_clamp_max);

    // only consider confidence interval at full value when above 25 bps
    let conf_component = if last_oracle_conf_pct > PERCENTAGE_PRECISION_U64 / 400 {
        last_oracle_conf_pct
    } else {
        last_oracle_conf_pct.safe_div(10)?
    };

    Ok((
        max(
            conf_component,
            vol_spread
                .safe_mul(long_vol_spread_factor)?
                .safe_div(PERCENTAGE_PRECISION)?
                .cast::<u64>()?,
        ),
        max(
            conf_component,
            vol_spread
                .safe_mul(short_vol_spread_factor)?
                .safe_div(PERCENTAGE_PRECISION)?
                .cast::<u64>()?,
        ),
    ))
}

pub fn calculate_inventory_liquidity_ratio(
    base_asset_amount_with_amm: i128,
    base_asset_reserve: u128,
    min_base_asset_reserve: u128,
    max_base_asset_reserve: u128,
) -> DriftResult<i128> {
    // computes min(1, x/(1-x)) for 0 < x < 1

    // inventory scale
    let (max_bids, max_asks) = _calculate_market_open_bids_asks(
        base_asset_reserve,
        min_base_asset_reserve,
        max_base_asset_reserve,
    )?;

    let min_side_liquidity = max_bids.min(max_asks.abs());

    let amm_inventory_pct = if base_asset_amount_with_amm.abs() < min_side_liquidity {
        base_asset_amount_with_amm
            .abs()
            .safe_mul(PERCENTAGE_PRECISION_I128)
            .unwrap_or(i128::MAX)
            .safe_div(min_side_liquidity.max(1))?
            .min(PERCENTAGE_PRECISION_I128)
    } else {
        PERCENTAGE_PRECISION_I128 // 100%
    };

    Ok(amm_inventory_pct)
}

pub fn calculate_spread_inventory_scale(
    base_asset_amount_with_amm: i128,
    base_asset_reserve: u128,
    min_base_asset_reserve: u128,
    max_base_asset_reserve: u128,
    directional_spread: u64,
    max_spread: u64,
) -> DriftResult<u64> {
    if base_asset_amount_with_amm == 0 {
        return Ok(BID_ASK_SPREAD_PRECISION);
    }

    let amm_inventory_pct = calculate_inventory_liquidity_ratio(
        base_asset_amount_with_amm,
        base_asset_reserve,
        min_base_asset_reserve,
        max_base_asset_reserve,
    )?;

    // only allow up to scale up of larger of MAX_BID_ASK_INVENTORY_SKEW_FACTOR or max spread
    let inventory_scale_max = MAX_BID_ASK_INVENTORY_SKEW_FACTOR.max(
        max_spread
            .safe_mul(BID_ASK_SPREAD_PRECISION)?
            .safe_div(max(directional_spread, 1))?,
    );

    let inventory_scale_capped = min(
        inventory_scale_max,
        BID_ASK_SPREAD_PRECISION
            .safe_add(
                inventory_scale_max
                    .safe_mul(amm_inventory_pct.unsigned_abs().cast()?)
                    .unwrap_or(u64::MAX)
                    .safe_div(PERCENTAGE_PRECISION_I128.cast()?)?,
            )
            .unwrap_or(u64::MAX),
    );

    Ok(inventory_scale_capped)
}

pub fn calculate_spread_leverage_scale(
    quote_asset_reserve: u128,
    terminal_quote_asset_reserve: u128,
    peg_multiplier: u128,
    base_asset_amount_with_amm: i128,
    reserve_price: u64,
    total_fee_minus_distributions: i128,
) -> DriftResult<u64> {
    let net_base_asset_value = quote_asset_reserve
        .cast::<i128>()?
        .safe_sub(terminal_quote_asset_reserve.cast::<i128>()?)?
        .safe_mul(peg_multiplier.cast::<i128>()?)?
        .safe_div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO_I128)?;

    let local_base_asset_value = base_asset_amount_with_amm
        .safe_mul(reserve_price.cast::<i128>()?)?
        .safe_div(AMM_TO_QUOTE_PRECISION_RATIO_I128 * PRICE_PRECISION_I128)?;

    let effective_leverage = max(0, local_base_asset_value.safe_sub(net_base_asset_value)?)
        .safe_mul(BID_ASK_SPREAD_PRECISION_I128)?
        .safe_div(max(0, total_fee_minus_distributions) + 1)?;

    let effective_leverage_capped = min(
        MAX_BID_ASK_INVENTORY_SKEW_FACTOR,
        BID_ASK_SPREAD_PRECISION.safe_add(max(0, effective_leverage).cast::<u64>()? + 1)?,
    );

    Ok(effective_leverage_capped)
}

pub fn calculate_spread_revenue_retreat_amount(
    base_spread: u32,
    max_spread: u64,
    net_revenue_since_last_funding: i64,
) -> DriftResult<u64> {
    // on-the-hour revenue scale
    let revenue_retreat_amount = if net_revenue_since_last_funding
        < DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT
    {
        let max_retreat = max_spread.safe_div(10)?;
        if net_revenue_since_last_funding
            >= DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT * 1000
        {
            min(
                max_retreat,
                base_spread
                    .cast::<u64>()?
                    .safe_mul(net_revenue_since_last_funding.unsigned_abs())?
                    .safe_div(DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT.unsigned_abs())?,
            )
        } else {
            max_retreat
        }
    } else {
        0
    };

    Ok(revenue_retreat_amount)
}

pub fn calculate_max_target_spread(
    reserve_price: u64,
    last_oracle_reserve_price_spread_pct: i64,
    last_oracle_conf_pct: u64,
    mark_std: u64,
    oracle_std: u64,
    max_spread: u32,
) -> DriftResult<u64> {
    let max_spread_baseline = last_oracle_reserve_price_spread_pct.unsigned_abs().max(
        last_oracle_conf_pct
            .safe_mul(2)?
            .max(
                mark_std
                    .max(oracle_std)
                    .safe_mul(PERCENTAGE_PRECISION_U64)?
                    .safe_div(reserve_price)?,
            )
            .min(BID_ASK_SPREAD_PRECISION),
    );

    let max_target_spread = max_spread.cast::<u64>()?.max(max_spread_baseline);
    Ok(max_target_spread)
}

#[allow(clippy::comparison_chain)]
pub fn calculate_spread(
    base_spread: u32,
    last_oracle_reserve_price_spread_pct: i64,
    last_oracle_conf_pct: u64,
    max_spread: u32,
    quote_asset_reserve: u128,
    terminal_quote_asset_reserve: u128,
    peg_multiplier: u128,
    base_asset_amount_with_amm: i128,
    reserve_price: u64,
    total_fee_minus_distributions: i128,
    net_revenue_since_last_funding: i64,
    base_asset_reserve: u128,
    min_base_asset_reserve: u128,
    max_base_asset_reserve: u128,
    mark_std: u64,
    oracle_std: u64,
    long_intensity_volume: u64,
    short_intensity_volume: u64,
    volume_24h: u64,
) -> DriftResult<(u32, u32)> {
    let (long_vol_spread, short_vol_spread) = calculate_long_short_vol_spread(
        last_oracle_conf_pct,
        reserve_price,
        mark_std,
        oracle_std,
        long_intensity_volume,
        short_intensity_volume,
        volume_24h,
    )?;

    let half_base_spread_u64 = (base_spread / 2) as u64;

    let mut long_spread = max(half_base_spread_u64, long_vol_spread);
    let mut short_spread = max(half_base_spread_u64, short_vol_spread);

    let max_target_spread = calculate_max_target_spread(
        reserve_price,
        last_oracle_reserve_price_spread_pct,
        last_oracle_conf_pct,
        mark_std,
        oracle_std,
        max_spread,
    )?;

    // oracle retreat
    // if mark - oracle < 0 (mark below oracle) and user going long then increase spread
    if last_oracle_reserve_price_spread_pct < 0 {
        long_spread = max(
            long_spread,
            last_oracle_reserve_price_spread_pct
                .unsigned_abs()
                .safe_add(long_vol_spread)?,
        );
    } else if last_oracle_reserve_price_spread_pct > 0 {
        short_spread = max(
            short_spread,
            last_oracle_reserve_price_spread_pct
                .unsigned_abs()
                .safe_add(short_vol_spread)?,
        );
    }

    // inventory scale
    let inventory_scale_capped = calculate_spread_inventory_scale(
        base_asset_amount_with_amm,
        base_asset_reserve,
        min_base_asset_reserve,
        max_base_asset_reserve,
        if base_asset_amount_with_amm > 0 {
            long_spread
        } else {
            short_spread
        },
        max_target_spread,
    )?;

    if base_asset_amount_with_amm > 0 {
        long_spread = long_spread
            .safe_mul(inventory_scale_capped)?
            .safe_div(BID_ASK_SPREAD_PRECISION)?;
    } else if base_asset_amount_with_amm < 0 {
        short_spread = short_spread
            .safe_mul(inventory_scale_capped)?
            .safe_div(BID_ASK_SPREAD_PRECISION)?;
    }

    if total_fee_minus_distributions <= 0 {
        long_spread = long_spread
            .safe_mul(DEFAULT_LARGE_BID_ASK_FACTOR)?
            .safe_div(BID_ASK_SPREAD_PRECISION)?;
        short_spread = short_spread
            .safe_mul(DEFAULT_LARGE_BID_ASK_FACTOR)?
            .safe_div(BID_ASK_SPREAD_PRECISION)?;
    } else {
        // effective leverage scale
        let effective_leverage_capped = calculate_spread_leverage_scale(
            quote_asset_reserve,
            terminal_quote_asset_reserve,
            peg_multiplier,
            base_asset_amount_with_amm,
            reserve_price,
            total_fee_minus_distributions,
        )?;

        if base_asset_amount_with_amm > 0 {
            long_spread = long_spread
                .safe_mul(effective_leverage_capped)?
                .safe_div(BID_ASK_SPREAD_PRECISION)?;
        } else if base_asset_amount_with_amm < 0 {
            short_spread = short_spread
                .safe_mul(effective_leverage_capped)?
                .safe_div(BID_ASK_SPREAD_PRECISION)?;
        }
    }

    let revenue_retreat_amount = calculate_spread_revenue_retreat_amount(
        base_spread,
        max_target_spread,
        net_revenue_since_last_funding,
    )?;
    if revenue_retreat_amount != 0 {
        if base_asset_amount_with_amm > 0 {
            long_spread = long_spread.safe_add(revenue_retreat_amount)?;
            short_spread = short_spread.safe_add(revenue_retreat_amount.safe_div(2)?)?;
        } else if base_asset_amount_with_amm < 0 {
            long_spread = long_spread.safe_add(revenue_retreat_amount.safe_div(2)?)?;
            short_spread = short_spread.safe_add(revenue_retreat_amount)?;
        } else {
            long_spread = long_spread.safe_add(revenue_retreat_amount.safe_div(2)?)?;
            short_spread = short_spread.safe_add(revenue_retreat_amount.safe_div(2)?)?;
        }
    }

    let (long_spread, short_spread) =
        cap_to_max_spread(long_spread, short_spread, max_target_spread)?;

    Ok((long_spread.cast::<u32>()?, short_spread.cast::<u32>()?))
}

pub fn get_spread_reserves(amm: &AMM, direction: PositionDirection) -> DriftResult<(u128, u128)> {
    let (base_asset_reserve, quote_asset_reserve) = match direction {
        PositionDirection::Long => (amm.ask_base_asset_reserve, amm.ask_quote_asset_reserve),
        PositionDirection::Short => (amm.bid_base_asset_reserve, amm.bid_quote_asset_reserve),
    };

    Ok((base_asset_reserve, quote_asset_reserve))
}

pub fn calculate_spread_reserves(
    amm: &AMM,
    direction: PositionDirection,
) -> DriftResult<(u128, u128)> {
    let spread = match direction {
        PositionDirection::Long => amm.long_spread,
        PositionDirection::Short => amm.short_spread,
    };

    let spread_with_offset: i32 = if direction == PositionDirection::Short {
        (-spread.cast::<i32>()?).safe_add(amm.reference_price_offset)?
    } else {
        spread.cast::<i32>()?.safe_add(amm.reference_price_offset)?
    };

    let quote_asset_reserve_delta = if spread_with_offset.abs() > 1 {
        let quote_reserve_divisor =
            BID_ASK_SPREAD_PRECISION_I128 / (spread_with_offset / 2).cast::<i128>()?;
        amm.quote_asset_reserve
            .cast::<i128>()?
            .safe_div(quote_reserve_divisor)?
    } else {
        0
    };

    let quote_asset_reserve = if quote_asset_reserve_delta > 0 {
        amm.quote_asset_reserve
            .safe_add(quote_asset_reserve_delta.unsigned_abs())?
    } else {
        amm.quote_asset_reserve
            .safe_sub(quote_asset_reserve_delta.unsigned_abs())?
    };

    let invariant_sqrt_u192 = U192::from(amm.sqrt_k);
    let invariant = invariant_sqrt_u192.safe_mul(invariant_sqrt_u192)?;

    let base_asset_reserve = invariant
        .safe_div(U192::from(quote_asset_reserve))?
        .try_to_u128()?;

    Ok((base_asset_reserve, quote_asset_reserve))
}

#[allow(clippy::comparison_chain)]
pub fn calculate_reference_price_offset(
    reserve_price: u64,
    last_24h_avg_funding_rate: i64,
    liquidity_fraction: i128,
    _min_order_size: u64,
    oracle_twap_fast: i64,
    mark_twap_fast: u64,
    oracle_twap_slow: i64,
    mark_twap_slow: u64,
    max_offset_pct: i64,
) -> DriftResult<i32> {
    if last_24h_avg_funding_rate == 0 {
        return Ok(0);
    }

    let max_offset_in_price = max_offset_pct
        .safe_mul(reserve_price.cast()?)?
        .safe_div(PERCENTAGE_PRECISION.cast()?)?;

    // calculate quote denominated market premium
    let mark_premium_minute: i64 = mark_twap_fast
        .cast::<i64>()?
        .safe_sub(oracle_twap_fast)?
        .clamp(-max_offset_in_price, max_offset_in_price);
    let mark_premium_hour: i64 = mark_twap_slow
        .cast::<i64>()?
        .safe_sub(oracle_twap_slow)?
        .clamp(-max_offset_in_price, max_offset_in_price);
    // convert last_24h_avg_funding_rate to quote denominated premium
    let mark_premium_day: i64 = last_24h_avg_funding_rate
        .safe_div(FUNDING_RATE_BUFFER.cast()?)?
        .safe_mul(24)?
        .clamp(-max_offset_in_price, max_offset_in_price); // todo: look at how 24h funding is calc w.r.t. the funding_period

    // take average clamped premium as the price-based offset
    let mark_premium_avg = mark_premium_minute
        .safe_add(mark_premium_hour)?
        .safe_add(mark_premium_day)?
        .safe_div(3_i64)?;

    let mark_premium_avg_pct: i64 = mark_premium_avg
        .safe_mul(PRICE_PRECISION_I64)?
        .safe_div(reserve_price.cast()?)?;

    let inventory_pct = liquidity_fraction
        .cast::<i64>()?
        .safe_mul(max_offset_pct)?
        .safe_div(PERCENTAGE_PRECISION.cast::<i64>()?)?
        .clamp(-max_offset_pct, max_offset_pct);

    // only apply when inventory is consistent with recent and 24h market premium
    let offset_pct = if (mark_premium_avg_pct >= 0 && inventory_pct >= 0)
        || (mark_premium_avg_pct <= 0 && inventory_pct <= 0)
    {
        mark_premium_avg_pct.safe_add(inventory_pct)?
    } else {
        0
    };

    let clamped_offset_pct = offset_pct.clamp(-max_offset_pct, max_offset_pct);

    validate!(
        clamped_offset_pct.abs() <= max_offset_pct,
        ErrorCode::InvalidAmmDetected,
        "clamp offset pct failed {}",
        clamped_offset_pct
    )?;

    clamped_offset_pct.cast()
}
