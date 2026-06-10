use std::cmp::{max, min};

use crate::msg;

use crate::controller::position::PositionDirection;
use crate::error::{ErrorCode, VelocityResult};
use crate::math::bn::U192;
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO_I128, AMM_TO_QUOTE_PRECISION_RATIO_I128,
    BID_ASK_SPREAD_PRECISION, BID_ASK_SPREAD_PRECISION_I128, DEFAULT_LARGE_BID_ASK_FACTOR,
    DEFAULT_REVENUE_SINCE_LAST_FUNDING_SPREAD_RETREAT, FUNDING_RATE_BUFFER,
    FUNDING_RATE_OFFSET_DENOMINATOR, MAX_BID_ASK_INVENTORY_SKEW_FACTOR, PEG_PRECISION,
    PERCENTAGE_PRECISION, PERCENTAGE_PRECISION_I128, PERCENTAGE_PRECISION_U64, PRICE_PRECISION,
    PRICE_PRECISION_I128, PRICE_PRECISION_I64,
};
use crate::math::safe_math::SafeMath;
use crate::state::oracle::MMOraclePriceData;
use crate::state::perp_market::{MarketStats, AMM};
use crate::validate;
use crate::vlp::amm::math::amm::_calculate_market_open_bids_asks;

#[cfg(test)]
mod tests;

/// Refresh the AMM's cached quote-time state (spreads, reference-price
/// offset, oracle-reserve spread pct, and spread-adjusted ask/bid reserves)
/// in place from durable inputs, stamping `last_spread_update_slot = slot`.
///
/// Restores the legacy `update_spreads` + `update_spread_reserves` mutators
/// that the AMM-decoupling refactor had briefly turned into a returns-only
/// `compute_amm_quote_state`. The cache lives back on `AMM`: it's refreshed
/// here on each AMM crank (`update_oracle_derived_stats`) and each fill
/// `setup`, then read directly by every quote/fill path — so two quotes in
/// the same refresh window see byte-identical spread state, and dashboards
/// can read the values straight off the account.
///
/// `reserve_price` is taken as an input (rather than re-derived from the
/// AMM) so callers can refresh against a just-projected AMM without
/// re-computing the price.
///
/// # Reference-price-offset smoothing
///
/// When the freshly computed `reference_price_offset` has the opposite sign
/// of `market_stats.last_reference_price_offset` AND
/// `amm.curve_update_intensity > 100`, the transition is smoothed across
/// slots rather than snapping. `market_stats.last_reference_price_offset`
/// is written by the crank after every refresh (from `amm.reference_price_offset`)
/// and seeds the smoothing for the next refresh.
pub fn update_amm_quote_state(
    amm: &mut AMM,
    market_stats: &MarketStats,
    mm_oracle_price_data: &MMOraclePriceData,
    reserve_price: u64,
    slot: u64,
) -> VelocityResult<()> {
    // ---- last_oracle_reserve_price_spread_pct -----------------------------
    let last_oracle_reserve_price_spread_pct =
        crate::vlp::amm::math::amm::calculate_oracle_reserve_price_spread_pct(
            amm,
            mm_oracle_price_data,
            Some(reserve_price),
        )?;

    // ---- reference_price_offset -------------------------------------------
    let max_ref_offset = amm.get_max_reference_price_offset()?;

    let reference_price_offset = if max_ref_offset > 0 {
        let liquidity_ratio = calculate_inventory_liquidity_ratio_for_reference_price_offset(
            amm.base_asset_amount_with_amm,
            amm.base_asset_reserve,
            amm.min_base_asset_reserve,
            amm.max_base_asset_reserve,
        )?;

        let signed_liquidity_ratio =
            liquidity_ratio.safe_mul(amm.get_protocol_owned_position()?.signum().cast()?)?;

        let deadband_pct = amm.get_reference_price_offset_deadband_pct()?;
        let liquidity_fraction_after_deadband =
            if signed_liquidity_ratio.unsigned_abs() <= deadband_pct {
                0
            } else {
                signed_liquidity_ratio.safe_sub(
                    deadband_pct
                        .cast::<i128>()?
                        .safe_mul(signed_liquidity_ratio.signum())?,
                )?
            };

        calculate_reference_price_offset(
            reserve_price,
            market_stats.last_24h_avg_funding_rate,
            liquidity_fraction_after_deadband,
            market_stats.min_order_size,
            market_stats
                .historical_oracle_data
                .last_oracle_price_twap_5min,
            market_stats.last_mark_price_twap_5min,
            market_stats.historical_oracle_data.last_oracle_price_twap,
            market_stats.last_mark_price_twap,
            max_ref_offset,
        )?
    } else {
        0
    };

    // ---- long/short spread (calculate_spread + amm_spread_adjustment) ----
    let (mut long_spread, mut short_spread) = if amm.curve_update_intensity > 0 {
        calculate_spread(
            amm.base_spread,
            last_oracle_reserve_price_spread_pct,
            market_stats.last_oracle_conf_pct,
            amm.max_spread,
            amm.quote_asset_reserve,
            amm.terminal_quote_asset_reserve,
            amm.peg_multiplier,
            amm.base_asset_amount_with_amm,
            reserve_price,
            amm.total_fee_minus_distributions,
            amm.net_revenue_since_last_funding,
            amm.base_asset_reserve,
            amm.min_base_asset_reserve,
            amm.max_base_asset_reserve,
            market_stats.mark_std,
            market_stats.oracle_std,
            market_stats.long_intensity_volume,
            market_stats.short_intensity_volume,
            market_stats.volume_24h,
            amm.amm_inventory_spread_adjustment,
        )?
    } else {
        let half_base_spread = amm.base_spread.safe_div(2)?;
        (half_base_spread, half_base_spread)
    };

    if amm.amm_spread_adjustment < 0 {
        let adjustment = amm.amm_spread_adjustment.unsigned_abs().cast()?;
        long_spread = long_spread
            .saturating_sub(long_spread.saturating_mul(adjustment).safe_div(100)?)
            .max(1);
        short_spread = short_spread
            .saturating_sub(short_spread.saturating_mul(adjustment).safe_div(100)?)
            .max(1);
    } else if amm.amm_spread_adjustment > 0 {
        let adjustment = amm.amm_spread_adjustment.cast()?;
        long_spread = long_spread
            .saturating_add(long_spread.saturating_mul(adjustment).safe_div_ceil(100)?)
            .max(1);
        short_spread = short_spread
            .saturating_add(short_spread.saturating_mul(adjustment).safe_div_ceil(100)?)
            .max(1);
    }

    // ---- reference-price-offset smoothing -------------------------------
    // Mirrors the legacy `update_spreads` smoothing branch (deleted from
    // `controller::amm`). Reads the previous offset from `MarketStats` so
    // there's per-crank continuity even though spread state is no longer
    // cached on `AMM`.
    let last_reference_price_offset = market_stats.last_reference_price_offset;
    let do_reference_price_smooth = last_reference_price_offset.signum()
        != reference_price_offset.signum()
        && amm.curve_update_intensity > 100;

    let final_reference_price_offset = if do_reference_price_smooth {
        let slots_passed = slot.saturating_sub(amm.last_spread_update_slot);
        let reference_price_delta = {
            let full_offset_delta = reference_price_offset
                .cast::<i128>()?
                .saturating_sub(last_reference_price_offset.cast::<i128>()?);
            let raw = full_offset_delta
                .abs()
                .min(slots_passed.cast::<i128>()?.safe_mul(1000_i128)?)
                .safe_div(10_i128)?
                .cast::<i32>()?;

            full_offset_delta.signum().cast::<i32>()?
                * (raw.max(10_i32).min(if last_reference_price_offset != 0 {
                    last_reference_price_offset.abs()
                } else {
                    reference_price_offset.abs()
                }))
        };

        let smoothed = last_reference_price_offset.safe_add(reference_price_delta)?;

        if reference_price_delta < 0 {
            long_spread = long_spread.safe_add(reference_price_delta.unsigned_abs())?;
            short_spread = short_spread.safe_add(smoothed.unsigned_abs())?;
        } else {
            short_spread = short_spread.safe_add(reference_price_delta.unsigned_abs())?;
            long_spread = long_spread.safe_add(smoothed.unsigned_abs())?;
        }
        smoothed
    } else {
        reference_price_offset
    };

    amm.long_spread = long_spread;
    amm.short_spread = short_spread;
    amm.reference_price_offset = final_reference_price_offset;
    amm.last_oracle_reserve_price_spread_pct = last_oracle_reserve_price_spread_pct;
    amm.last_spread_update_slot = slot;

    // Derive the spread-adjusted ask/bid reserves from the just-written
    // spreads + current curve reserves.
    refresh_cached_spread_reserves(amm)?;

    validate_amm_quote_state(amm)?;
    Ok(())
}

/// Recompute the cached ask/bid spread reserves from the AMM's currently-cached
/// `long_spread` / `short_spread` / `reference_price_offset` and its live
/// `base`/`quote` reserves + `sqrt_k`. Restores the legacy `update_spread_reserves`
/// mutator: [`update_amm_quote_state`] runs it after recomputing the spreads, and
/// `QuoterCommit::commit_fill` runs it after a fill moves the reserves so the
/// cached projections (which dashboards read) stay consistent with the curve.
/// Leaves the spreads themselves untouched.
pub fn refresh_cached_spread_reserves(amm: &mut AMM) -> VelocityResult<()> {
    let (ask_base_asset_reserve, ask_quote_asset_reserve) = compute_spread_reserves_for_direction(
        amm,
        amm.long_spread,
        amm.reference_price_offset,
        PositionDirection::Long,
    )?;
    let (bid_base_asset_reserve, bid_quote_asset_reserve) = compute_spread_reserves_for_direction(
        amm,
        amm.short_spread,
        amm.reference_price_offset,
        PositionDirection::Short,
    )?;

    // Mirror the clamp from the legacy `update_spread_reserves`: with no
    // reference offset, asks stay >= reserve and bids stay <= reserve.
    if amm.reference_price_offset == 0 {
        amm.ask_base_asset_reserve = ask_base_asset_reserve.min(amm.base_asset_reserve);
        amm.ask_quote_asset_reserve = ask_quote_asset_reserve.max(amm.quote_asset_reserve);
        amm.bid_base_asset_reserve = bid_base_asset_reserve.max(amm.base_asset_reserve);
        amm.bid_quote_asset_reserve = bid_quote_asset_reserve.min(amm.quote_asset_reserve);
    } else {
        amm.ask_base_asset_reserve = ask_base_asset_reserve;
        amm.ask_quote_asset_reserve = ask_quote_asset_reserve;
        amm.bid_base_asset_reserve = bid_base_asset_reserve;
        amm.bid_quote_asset_reserve = bid_quote_asset_reserve;
    }
    Ok(())
}

/// Self-check the cached spread/reserve invariants master enforced inside
/// `validate_perp_market`. Run at the tail of [`update_amm_quote_state`] so a
/// corrupted refresh result is caught at the source — the only way bad spread
/// state can reach a fill is through that refresh.
pub fn validate_amm_quote_state(amm: &AMM) -> VelocityResult<()> {
    use crate::math::constants::BID_ASK_SPREAD_PRECISION;

    // long+short never exceeds the precision ceiling (== 100%).
    validate!(
        amm.long_spread.safe_add(amm.short_spread)?.cast::<u64>()? <= BID_ASK_SPREAD_PRECISION,
        ErrorCode::InvalidAmmDetected,
        "amm long_spread {} + short_spread {} > BID_ASK_SPREAD_PRECISION ({}); max_spread {}",
        amm.long_spread,
        amm.short_spread,
        BID_ASK_SPREAD_PRECISION,
        amm.max_spread,
    )?;

    // When both adjustments are non-negative, the post-spread bid/ask
    // can't be tighter than `base_spread - 2` (the -2 absorbs i32→u32
    // signed rounding from the spread builders).
    if amm.amm_spread_adjustment >= 0 && amm.amm_inventory_spread_adjustment >= 0 {
        validate!(
            amm.long_spread.safe_add(amm.short_spread)? >= amm.base_spread.saturating_sub(2),
            ErrorCode::InvalidAmmDetected,
            "amm long_spread {} + short_spread {} < base_spread {} - 2",
            amm.long_spread,
            amm.short_spread,
            amm.base_spread,
        )?;
    }

    // Spread-reserve bounds — used by `swap_base_asset` to price a fill.
    // `reference_price_offset` direction picks which side's bound is
    // checked (the bound on the side that fills first).
    if amm.reference_price_offset <= 0 {
        validate!(
            amm.bid_base_asset_reserve >= amm.base_asset_reserve
                && amm.bid_quote_asset_reserve <= amm.quote_asset_reserve,
            ErrorCode::InvalidAmmDetected,
            "amm bid reserves invalid: base {} -> {}, quote {} -> {}",
            amm.bid_base_asset_reserve,
            amm.base_asset_reserve,
            amm.bid_quote_asset_reserve,
            amm.quote_asset_reserve,
        )?;
    }
    if amm.reference_price_offset >= 0 {
        validate!(
            amm.ask_base_asset_reserve <= amm.base_asset_reserve
                && amm.ask_quote_asset_reserve >= amm.quote_asset_reserve,
            ErrorCode::InvalidAmmDetected,
            "amm ask reserves invalid: base {} -> {}, quote {} -> {}",
            amm.ask_base_asset_reserve,
            amm.base_asset_reserve,
            amm.ask_quote_asset_reserve,
            amm.quote_asset_reserve,
        )?;
    }

    Ok(())
}

/// Pure form of the legacy `calculate_spread_reserves` mutator: takes the
/// spread + reference offset directly instead of reading cached AMM fields
/// (which were removed in the AMM-decoupling refactor).
pub(crate) fn compute_spread_reserves_for_direction(
    amm: &AMM,
    spread: u32,
    reference_price_offset: i32,
    direction: PositionDirection,
) -> VelocityResult<(u128, u128)> {
    let spread_with_offset: i32 = if direction == PositionDirection::Short {
        (-spread.cast::<i32>()?).safe_add(reference_price_offset)?
    } else {
        spread.cast::<i32>()?.safe_add(reference_price_offset)?
    };

    let quote_asset_reserve_delta = if spread_with_offset.abs() > 1 {
        let quote_reserve_divisor =
            BID_ASK_SPREAD_PRECISION_I128 / (spread_with_offset / 2).cast::<i128>()?;
        amm.quote_asset_reserve
            .cast::<i128>()?
            .safe_div(quote_reserve_divisor)?
    } else {
        0_i128
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

pub fn calculate_base_asset_amount_to_trade_to_price(
    amm: &AMM,
    limit_price: u64,
    direction: PositionDirection,
) -> VelocityResult<(u64, PositionDirection)> {
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
        match direction {
            PositionDirection::Long => amm.ask_base_asset_reserve,
            PositionDirection::Short => amm.bid_base_asset_reserve,
        }
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
) -> VelocityResult<(u64, u64)> {
    let total_spread = long_spread.safe_add(short_spread)?;

    if total_spread > max_spread {
        if long_spread > short_spread {
            long_spread = long_spread
                .saturating_mul(max_spread)
                .safe_div_ceil(total_spread)?;
            short_spread = max_spread.safe_sub(long_spread)?;
        } else {
            short_spread = short_spread
                .saturating_mul(max_spread)
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
) -> VelocityResult<(u64, u64)> {
    // 1.6 * std
    let market_avg_std_pct: u128 = oracle_std
        .safe_add(mark_std)?
        .cast::<u128>()?
        .safe_mul(PERCENTAGE_PRECISION)?
        .safe_div(reserve_price.cast::<u128>()?)?
        .safe_div(2)?;

    let vol_spread: u128 = last_oracle_conf_pct
        .cast::<u128>()?
        .max(market_avg_std_pct.safe_div(4)?);

    let factor_clamp_min: u128 = PERCENTAGE_PRECISION / 100; // .01
    let factor_clamp_max: u128 = PERCENTAGE_PRECISION; // 1

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
        last_oracle_conf_pct.safe_div(20)?
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
) -> VelocityResult<i128> {
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

pub fn calculate_inventory_liquidity_ratio_for_reference_price_offset(
    base_asset_amount_with_amm: i128,
    base_asset_reserve: u128,
    min_base_asset_reserve: u128,
    max_base_asset_reserve: u128,
) -> VelocityResult<i128> {
    // inventory scale
    let (max_bids, max_asks) = _calculate_market_open_bids_asks(
        base_asset_reserve,
        min_base_asset_reserve,
        max_base_asset_reserve,
    )?;

    let avg_liquidity = (max_bids.safe_add(max_asks.abs())?).safe_div(2)?;

    let amm_inventory_pct = if base_asset_amount_with_amm.abs() < avg_liquidity {
        base_asset_amount_with_amm
            .abs()
            .safe_mul(PERCENTAGE_PRECISION_I128)
            .unwrap_or(i128::MAX)
            .safe_div(avg_liquidity.max(1))?
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
) -> VelocityResult<u64> {
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
) -> VelocityResult<u64> {
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
) -> VelocityResult<u64> {
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
    last_oracle_reserve_price_spread_pct: i64,
    reserve_price: u64,
    last_oracle_conf_pct: u64,
    mark_std: u64,
    oracle_std: u64,
    max_spread: u32,
) -> VelocityResult<u64> {
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
    amm_inventory_spread_adjustment: i8,
) -> VelocityResult<(u32, u32)> {
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
        last_oracle_reserve_price_spread_pct,
        reserve_price,
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
            .saturating_mul(DEFAULT_LARGE_BID_ASK_FACTOR)
            .safe_div(BID_ASK_SPREAD_PRECISION)?;
        short_spread = short_spread
            .saturating_mul(DEFAULT_LARGE_BID_ASK_FACTOR)
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

    if amm_inventory_spread_adjustment < 0 {
        let adjustment: u64 = amm_inventory_spread_adjustment
            .cast::<i64>()?
            .unsigned_abs();
        long_spread = max(half_base_spread_u64, long_vol_spread).max(
            long_spread
                .saturating_sub(long_spread.saturating_mul(adjustment).safe_div(100)?)
                .max(1),
        );
        short_spread = max(half_base_spread_u64, short_vol_spread).max(
            short_spread
                .saturating_sub(short_spread.saturating_mul(adjustment).safe_div(100)?)
                .max(1),
        );
    } else if amm_inventory_spread_adjustment > 0 {
        let adjustment = amm_inventory_spread_adjustment.cast()?;
        long_spread = max(half_base_spread_u64, long_vol_spread).max(
            long_spread
                .saturating_add(long_spread.saturating_mul(adjustment).safe_div_ceil(100)?)
                .max(1),
        );
        short_spread = max(half_base_spread_u64, short_vol_spread).max(
            short_spread
                .saturating_add(short_spread.saturating_mul(adjustment).safe_div_ceil(100)?)
                .max(1),
        );
    }

    let (long_spread, short_spread) =
        cap_to_max_spread(long_spread, short_spread, max_target_spread)?;

    Ok((long_spread.cast::<u32>()?, short_spread.cast::<u32>()?))
}

// The legacy `get_spread_reserves` / `update_spread_reserves` mutators folded
// into [`update_amm_quote_state`], which writes the cached
// `ask_*_asset_reserve` / `bid_*_asset_reserve` onto the AMM. Callers read
// those fields directly off the AMM. The pure per-direction computation lives
// in `compute_spread_reserves_for_direction`.

#[cfg(test)]
/// Test-only convenience: materialise the spread reserves for one
/// direction from a `PerpMarket`, using a zero-spread / zero-offset quote.
/// Production code refreshes the cached reserves via `update_amm_quote_state`.
/// Tests use this shim where they previously called the deleted
/// `calculate_spread_reserves` mutator path and don't need a real spread.
pub fn calculate_spread_reserves(
    market: &crate::state::perp_market::PerpMarket,
    direction: PositionDirection,
) -> VelocityResult<(u128, u128)> {
    compute_spread_reserves_for_direction(&market.amm, 0, 0, direction)
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
) -> VelocityResult<i32> {
    if last_24h_avg_funding_rate == 0 || liquidity_fraction == 0 {
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
        .safe_sub(
            oracle_twap_slow
                .abs()
                .safe_div(FUNDING_RATE_OFFSET_DENOMINATOR)?,
        )?
        .clamp(-max_offset_in_price, max_offset_in_price); // todo: look at how 24h funding is calc w.r.t. the funding_period
                                                           // take average clamped premium as the price-based offset
    let mark_premium_avg = mark_premium_minute
        .safe_add(mark_premium_hour)?
        .safe_add(mark_premium_day)?
        .safe_div(3_i64)?;

    let mark_premium_avg_pct: i64 = mark_premium_avg
        .safe_mul(PRICE_PRECISION_I64)?
        .safe_div(reserve_price.cast()?)?;

    // only apply when inventory is consistent with recent and 24h market premium
    let offset_pct = if (mark_premium_avg_pct >= 0 && liquidity_fraction >= 0)
        || (mark_premium_avg_pct <= 0 && liquidity_fraction <= 0)
    {
        mark_premium_avg_pct
            .safe_mul(liquidity_fraction.unsigned_abs().cast::<i64>()?)?
            .safe_div(2)?
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
