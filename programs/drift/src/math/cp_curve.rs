use solana_program::msg;

use crate::error::{DriftResult, ErrorCode};
use crate::math::amm;
use crate::math::bn;
use crate::math::bn::U192;
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, AMM_TO_QUOTE_PRECISION_RATIO_I128, K_BPS_UPDATE_SCALE,
    MAX_K_BPS_DECREASE, MAX_SQRT_K, PEG_PRECISION, PERCENTAGE_PRECISION_I128, QUOTE_PRECISION,
};
use crate::math::position::{calculate_base_asset_value, calculate_base_asset_value_and_pnl};
use crate::math::safe_math::SafeMath;

use crate::state::perp_market::{MarketStatus, PerpMarket};
use crate::validate;

#[cfg(test)]
mod tests;

pub fn calculate_budgeted_k_scale(
    market: &mut PerpMarket,
    budget: i128,
    k_pct_upper_bound: i128,
    k_pct_lower_bound: i128,
) -> DriftResult<(u128, u128)> {
    validate!(
        k_pct_upper_bound >= K_BPS_UPDATE_SCALE,
        ErrorCode::InvalidUpdateK,
        "invalid k_pct_upper_bound={} > {}",
        k_pct_upper_bound,
        K_BPS_UPDATE_SCALE
    )?;

    validate!(
        (K_BPS_UPDATE_SCALE - MAX_K_BPS_DECREASE..=K_BPS_UPDATE_SCALE).contains(&k_pct_lower_bound),
        ErrorCode::InvalidUpdateK,
        "invalid k_pct_lower_bound={} vs {}",
        k_pct_lower_bound,
        K_BPS_UPDATE_SCALE - MAX_K_BPS_DECREASE
    )?;

    let (numerator, denominator) = _calculate_budgeted_k_scale(
        market.amm.base_asset_reserve,
        market.amm.quote_asset_reserve,
        budget,
        market.amm.peg_multiplier,
        market.amm.base_asset_amount_with_amm,
        k_pct_upper_bound,
        k_pct_lower_bound,
    )?;

    Ok((numerator, denominator))
}

pub fn _calculate_budgeted_k_scale(
    x: u128,
    y: u128,
    budget: i128,
    q: u128,
    d: i128,
    k_pct_upper_bound: i128,
    k_pct_lower_bound: i128,
) -> DriftResult<(u128, u128)> {
    // let curve_update_intensity = curve_update_intensity as i128;
    let c = -budget;
    let q = q.cast::<i128>()?;

    let c_sign: i128 = if c > 0 { 1 } else { -1 };
    let d_sign: i128 = if d > 0 { 1 } else { -1 };

    let rounding_bias: i128 = c_sign.safe_mul(d_sign)?;

    let x_d = x.cast::<i128>()?.safe_add(d)?;

    let amm_reserve_precision_u192 = U192::from(AMM_RESERVE_PRECISION);
    let x_times_x_d_u192 = U192::from(x)
        .safe_mul(U192::from(x_d))?
        .safe_div(amm_reserve_precision_u192)?;

    let quote_precision_u192 = U192::from(QUOTE_PRECISION);
    let x_times_x_d_c = x_times_x_d_u192
        .safe_mul(U192::from(c.unsigned_abs()))?
        .safe_div(quote_precision_u192)?
        .try_to_u128()?;

    let c_times_x_d_d = U192::from(c.unsigned_abs())
        .safe_mul(U192::from(x_d.unsigned_abs()))?
        .safe_div(quote_precision_u192)?
        .safe_mul(U192::from(d.unsigned_abs()))?
        .safe_div(amm_reserve_precision_u192)?
        .try_to_u128()?;

    let pegged_quote_times_dd = U192::from(y)
        .safe_mul(U192::from(d.unsigned_abs()))?
        .safe_div(amm_reserve_precision_u192)?
        .safe_mul(U192::from(d.unsigned_abs()))?
        .safe_div(amm_reserve_precision_u192)?
        .safe_mul(U192::from(q))?
        .safe_div(U192::from(PEG_PRECISION))?
        .try_to_u128()?
        .cast::<i128>()?;

    let numer1 = pegged_quote_times_dd;

    let numer2 = c_times_x_d_d.cast::<i128>()?.safe_mul(rounding_bias)?;

    let denom1 = x_times_x_d_c.cast::<i128>()?.safe_mul(c_sign)?;

    let denom2 = pegged_quote_times_dd;

    // protocol is spending to increase k
    if c_sign < 0 {
        // thus denom1 is negative and solution is unstable
        if x_times_x_d_c > pegged_quote_times_dd.unsigned_abs() {
            msg!("cost exceeds possible amount to spend");
            msg!("k * {:?}/{:?}", k_pct_upper_bound, K_BPS_UPDATE_SCALE);
            return Ok((
                k_pct_upper_bound.cast::<u128>()?,
                K_BPS_UPDATE_SCALE.cast::<u128>()?,
            ));
        }
    }

    let mut numerator = (numer1.safe_sub(numer2)?).safe_div(AMM_TO_QUOTE_PRECISION_RATIO_I128)?;
    let mut denominator = denom1
        .safe_add(denom2)?
        .safe_div(AMM_TO_QUOTE_PRECISION_RATIO_I128)?;

    if numerator < 0 && denominator < 0 {
        numerator = numerator.abs();
        denominator = denominator.abs();
    }
    assert!((numerator > 0 && denominator > 0));

    let (numerator, denominator) = if numerator > denominator {
        let current_pct_change = numerator
            .safe_mul(PERCENTAGE_PRECISION_I128)?
            .safe_div(denominator)?;

        let maximum_pct_change = k_pct_upper_bound
            .safe_mul(PERCENTAGE_PRECISION_I128)?
            .safe_div(K_BPS_UPDATE_SCALE)?;

        if current_pct_change > maximum_pct_change {
            (k_pct_upper_bound, K_BPS_UPDATE_SCALE)
        } else {
            (current_pct_change, K_BPS_UPDATE_SCALE)
        }
    } else {
        let current_pct_change = numerator
            .safe_mul(PERCENTAGE_PRECISION_I128)?
            .safe_div(denominator)?;

        let maximum_pct_change = k_pct_lower_bound
            .safe_mul(PERCENTAGE_PRECISION_I128)?
            .safe_div(K_BPS_UPDATE_SCALE)?;

        if current_pct_change < maximum_pct_change {
            (k_pct_lower_bound, K_BPS_UPDATE_SCALE)
        } else {
            (current_pct_change, K_BPS_UPDATE_SCALE)
        }
    };

    Ok((numerator.cast::<u128>()?, denominator.cast::<u128>()?))
}
/// To find the cost of adjusting k, compare the net market value before and after adjusting k
/// Increasing k costs the protocol terminal money because it reduces slippage and improves the exit price for net market position
/// Decreasing k relieves the protocol terminal money because it increases slippage and hurts the exit price for net market position
pub fn adjust_k_cost(
    market: &mut PerpMarket,
    update_k_result: &UpdateKResult,
) -> DriftResult<i128> {
    let mut market_clone = *market;

    // Find the net market value before adjusting k
    let (current_net_market_value, _) = calculate_base_asset_value_and_pnl(
        market_clone.amm.base_asset_amount_with_amm,
        0,
        &market_clone.amm,
    )?;

    update_k(&mut market_clone, update_k_result)?;

    let (_new_net_market_value, cost) = calculate_base_asset_value_and_pnl(
        market_clone.amm.base_asset_amount_with_amm,
        current_net_market_value,
        &market_clone.amm,
    )?;

    Ok(cost)
}

/// To find the cost of adjusting k, compare the net market value before and after adjusting k
/// Increasing k costs the protocol money because it reduces slippage and improves the exit price for net market position
/// Decreasing k costs the protocol money because it increases slippage and hurts the exit price for net market position
pub fn adjust_k_cost_and_update(
    market: &mut PerpMarket,
    update_k_result: &UpdateKResult,
) -> DriftResult<i128> {
    // Find the net market value before adjusting k
    let current_net_market_value =
        calculate_base_asset_value(market.amm.base_asset_amount_with_amm, &market.amm)?;

    update_k(market, update_k_result)?;

    let (_new_net_market_value, cost) = calculate_base_asset_value_and_pnl(
        market.amm.base_asset_amount_with_amm,
        current_net_market_value,
        &market.amm,
    )?;

    Ok(cost)
}

pub struct UpdateKResult {
    pub sqrt_k: u128,
    pub base_asset_reserve: u128,
    pub quote_asset_reserve: u128,
}

pub fn get_update_k_result(
    market: &PerpMarket,
    new_sqrt_k: bn::U192,
    bound_update: bool,
) -> DriftResult<UpdateKResult> {
    let sqrt_k_ratio_precision = bn::U192::from(AMM_RESERVE_PRECISION);

    let old_sqrt_k = bn::U192::from(market.amm.sqrt_k);
    let mut sqrt_k_ratio = new_sqrt_k
        .safe_mul(sqrt_k_ratio_precision)?
        .safe_div(old_sqrt_k)?;

    // if decreasing k, max decrease ratio for single transaction is 2.5%
    if bound_update && sqrt_k_ratio < U192::from(975_000_000_u128) {
        return Err(ErrorCode::InvalidUpdateK);
    }

    if sqrt_k_ratio < sqrt_k_ratio_precision {
        sqrt_k_ratio = sqrt_k_ratio + 1;
    }

    let sqrt_k = new_sqrt_k.try_to_u128()?;

    validate!(
        sqrt_k_ratio < sqrt_k_ratio_precision || sqrt_k <= MAX_SQRT_K,
        ErrorCode::InvalidUpdateK,
        "cannot increase sqrt_k={} past MAX_SQRT_K",
        sqrt_k
    )?;

    // only allow too small when market is in reduce only mode
    if market.status != MarketStatus::ReduceOnly
        && new_sqrt_k < old_sqrt_k
        && market.amm.base_asset_amount_with_amm.unsigned_abs() > sqrt_k
    {
        // todo, check less lp_tokens as well
        msg!("new_sqrt_k too small relative to market imbalance");
        return Err(ErrorCode::InvalidUpdateK);
    }

    let base_asset_reserve = bn::U192::from(market.amm.base_asset_reserve)
        .safe_mul(sqrt_k_ratio)?
        .safe_div(sqrt_k_ratio_precision)?
        .try_to_u128()?;

    let invariant_sqrt_u192 = U192::from(sqrt_k);
    let invariant = invariant_sqrt_u192.safe_mul(invariant_sqrt_u192)?;

    let quote_asset_reserve = invariant
        .safe_div(U192::from(base_asset_reserve))?
        .try_to_u128()?;

    Ok(UpdateKResult {
        sqrt_k,
        base_asset_reserve,
        quote_asset_reserve,
    })
}

pub fn update_k(market: &mut PerpMarket, update_k_result: &UpdateKResult) -> DriftResult {
    market.amm.base_asset_reserve = update_k_result.base_asset_reserve;
    market.amm.quote_asset_reserve = update_k_result.quote_asset_reserve;
    market.amm.sqrt_k = update_k_result.sqrt_k;

    let (new_terminal_quote_reserve, new_terminal_base_reserve) =
        amm::calculate_terminal_reserves(&market.amm)?;
    market.amm.terminal_quote_asset_reserve = new_terminal_quote_reserve;

    let (min_base_asset_reserve, max_base_asset_reserve) =
        amm::calculate_bid_ask_bounds(market.amm.concentration_coef, new_terminal_base_reserve)?;
    market.amm.min_base_asset_reserve = min_base_asset_reserve;
    market.amm.max_base_asset_reserve = max_base_asset_reserve;

    let reserve_price_after = market.amm.reserve_price()?;
    crate::controller::amm::update_spreads(&mut market.amm, reserve_price_after)?;

    Ok(())
}
