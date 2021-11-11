use std::cmp::max;

use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

use crate::controller::amm::SwapDirection;
use crate::error::*;
use crate::math::bn;
use crate::math::bn::U192;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128};
use crate::math::constants::{MARK_PRICE_PRECISION, ONE_HOUR, PRICE_TO_PEG_PRECISION_RATIO};
use crate::math::position::_calculate_base_asset_value_and_pnl;
use crate::math_error;
use crate::state::market::{Market, AMM};
use crate::state::state::{PriceDivergenceGuardRails, ValidityGuardRails};

pub fn calculate_price(
    unpegged_quote_asset_amount: u128,
    base_asset_amount: u128,
    peg_multiplier: u128,
) -> ClearingHouseResult<u128> {
    let peg_quote_asset_amount = unpegged_quote_asset_amount
        .checked_mul(peg_multiplier)
        .ok_or_else(math_error!())?;

    return U192::from(peg_quote_asset_amount)
        .checked_mul(U192::from(PRICE_TO_PEG_PRECISION_RATIO))
        .ok_or_else(math_error!())?
        .checked_div(U192::from(base_asset_amount))
        .ok_or_else(math_error!())?
        .try_to_u128();
}

pub fn update_mark_twap(
    amm: &mut AMM,
    now: i64,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<u128> {
    let mark_twap = calculate_new_mark_twap(amm, now, precomputed_mark_price)?;
    amm.last_mark_price_twap = mark_twap;
    amm.last_mark_price_twap_ts = now;

    return Ok(mark_twap);
}

#[allow(dead_code)]
pub fn update_oracle_mark_spread_twap(
    amm: &mut AMM,
    now: i64,
    new_spread: i128,
) -> ClearingHouseResult<i128> {
    let since_last = cast_to_i128(max(
        1,
        now.checked_sub(amm.last_mark_price_twap_ts)
            .ok_or_else(math_error!())?,
    ))?;

    let from_start = max(
        1,
        ONE_HOUR.checked_sub(since_last).ok_or_else(math_error!())?,
    );

    let new_twap = calculate_twap(
        new_spread,
        amm.last_oracle_mark_spread_twap,
        since_last,
        from_start,
    )?;
    amm.last_oracle_mark_spread_twap = new_twap;
    return Ok(new_twap);
}

pub fn calculate_new_mark_twap(
    amm: &AMM,
    now: i64,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<u128> {
    let since_last = cast_to_i128(max(
        1,
        now.checked_sub(amm.last_mark_price_twap_ts)
            .ok_or_else(math_error!())?,
    ))?;
    let from_start = max(
        1,
        ONE_HOUR.checked_sub(since_last).ok_or_else(math_error!())?,
    );
    let current_price = match precomputed_mark_price {
        Some(mark_price) => mark_price,
        None => amm.mark_price()?,
    };

    let new_twap: u128 = cast(calculate_twap(
        cast(current_price)?,
        cast(amm.last_mark_price_twap)?,
        since_last,
        from_start,
    )?)?;

    return Ok(new_twap);
}

pub fn calculate_twap(
    new_data: i128,
    old_data: i128,
    new_weight: i128,
    old_weight: i128,
) -> ClearingHouseResult<i128> {
    let denominator = new_weight
        .checked_add(old_weight)
        .ok_or_else(math_error!())?;
    let prev_twap_99 = old_data.checked_mul(old_weight).ok_or_else(math_error!())?;
    let latest_price_01 = new_data.checked_mul(new_weight).ok_or_else(math_error!())?;
    let new_twap = prev_twap_99
        .checked_add(latest_price_01)
        .ok_or_else(math_error!())?
        .checked_div(denominator)
        .ok_or_else(math_error!());
    return new_twap;
}

pub fn calculate_swap_output(
    swap_amount: u128,
    input_asset_amount: u128,
    direction: SwapDirection,
    invariant_sqrt: u128,
) -> ClearingHouseResult<(u128, u128)> {
    let invariant_sqrt_u192 = U192::from(invariant_sqrt);
    let invariant = invariant_sqrt_u192
        .checked_mul(invariant_sqrt_u192)
        .ok_or_else(math_error!())?;

    let new_input_amount = if let SwapDirection::Add = direction {
        input_asset_amount
            .checked_add(swap_amount)
            .ok_or_else(math_error!())?
    } else {
        input_asset_amount
            .checked_sub(swap_amount)
            .ok_or_else(math_error!())?
    };

    let new_input_amount_u192 = U192::from(new_input_amount);
    let new_output_amount = invariant
        .checked_div(new_input_amount_u192)
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    return Ok((new_output_amount, new_input_amount));
}

pub fn calculate_oracle_mark_spread(
    amm: &AMM,
    price_oracle: &AccountInfo,
    window: u32,
    clock_slot: u64,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(i128, i128)> {
    let mark_price: i128;

    let (oracle_price, oracle_twap, _oracle_conf, _oracle_twac, _oracle_delay) =
        amm.get_oracle_price(price_oracle, clock_slot)?;

    if window > 0 {
        mark_price = cast_to_i128(amm.last_mark_price_twap)?;
        let price_spread = mark_price
            .checked_sub(oracle_twap)
            .ok_or_else(math_error!())?;

        Ok((oracle_twap, price_spread))
    } else {
        mark_price = match precomputed_mark_price {
            Some(mark_price) => cast_to_i128(mark_price)?,
            None => cast_to_i128(amm.mark_price()?)?,
        };

        let price_spread = mark_price
            .checked_sub(oracle_price)
            .ok_or_else(math_error!())?;

        Ok((oracle_price, price_spread))
    }
}

pub fn calculate_oracle_mark_spread_pct(
    amm: &AMM,
    price_oracle: &AccountInfo,
    window: u32,
    clock_slot: u64,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(i128, i128, i128)> {
    let (oracle_price, price_spread) = calculate_oracle_mark_spread(
        amm,
        price_oracle,
        window,
        clock_slot,
        precomputed_mark_price,
    )?;

    let price_spread_pct = price_spread
        .checked_shl(10)
        .ok_or_else(math_error!())?
        .checked_div(oracle_price)
        .ok_or_else(math_error!())?;

    Ok((oracle_price, price_spread, price_spread_pct))
}

pub fn is_oracle_mark_too_divergent(
    price_spread_pct: i128,
    oracle_guard_rails: &PriceDivergenceGuardRails,
) -> ClearingHouseResult<bool> {
    let max_divergence = oracle_guard_rails
        .mark_oracle_divergence_numerator
        .checked_shl(10)
        .ok_or_else(math_error!())?
        .checked_div(oracle_guard_rails.mark_oracle_divergence_denominator)
        .ok_or_else(math_error!())?;

    Ok(price_spread_pct.unsigned_abs() > max_divergence)
}

pub fn is_oracle_valid(
    amm: &AMM,
    price_oracle: &AccountInfo,
    clock_slot: u64,
    valid_oracle_guard_rails: &ValidityGuardRails,
) -> ClearingHouseResult<bool> {
    let (oracle_price, oracle_twap, oracle_conf, oracle_twap_conf, oracle_delay) =
        amm.get_oracle_price(price_oracle, clock_slot)?;

    let is_oracle_price_nonpositive = (oracle_twap <= 0) || (oracle_price <= 0);

    let is_oracle_price_too_volatile = ((oracle_price
        .checked_div(max(1, oracle_twap))
        .ok_or_else(math_error!())?)
    .gt(&valid_oracle_guard_rails.too_volatile_ratio))
        || ((oracle_twap
            .checked_div(max(1, oracle_price))
            .ok_or_else(math_error!())?)
        .gt(&valid_oracle_guard_rails.too_volatile_ratio));

    let conf_denom_of_price = cast_to_u128(oracle_price)?
        .checked_div(max(1, oracle_conf))
        .ok_or_else(math_error!())?;
    let conf_denom_of_twap_price = cast_to_u128(oracle_twap)?
        .checked_div(max(1, oracle_twap_conf))
        .ok_or_else(math_error!())?;
    let is_conf_too_large = (conf_denom_of_price
        .lt(&valid_oracle_guard_rails.confidence_interval_max_size))
        || (conf_denom_of_twap_price.lt(&valid_oracle_guard_rails.confidence_interval_max_size));

    let is_stale = oracle_delay.gt(&valid_oracle_guard_rails.slots_before_stale);

    Ok(!(is_stale
        || is_conf_too_large
        || is_oracle_price_nonpositive
        || is_oracle_price_too_volatile))
}

pub fn adjust_k_cost(market: &mut Market, new_sqrt_k: bn::U256) -> ClearingHouseResult<i128> {
    // price is fixed, calculate cost of changing k in market
    let (cur_net_value, _) =
        _calculate_base_asset_value_and_pnl(market.base_asset_amount, 0, &market.amm)?;

    let k_mult = new_sqrt_k
        .checked_mul(bn::U256::from(MARK_PRICE_PRECISION))
        .ok_or_else(math_error!())?
        .checked_div(bn::U256::from(market.amm.sqrt_k))
        .ok_or_else(math_error!())?;

    market.amm.sqrt_k = new_sqrt_k.try_to_u128().unwrap();
    market.amm.base_asset_reserve = bn::U256::from(market.amm.base_asset_reserve)
        .checked_mul(k_mult)
        .ok_or_else(math_error!())?
        .checked_div(bn::U256::from(MARK_PRICE_PRECISION))
        .ok_or_else(math_error!())?
        .try_to_u128()
        .unwrap();
    market.amm.quote_asset_reserve = bn::U256::from(market.amm.quote_asset_reserve)
        .checked_mul(k_mult)
        .ok_or_else(math_error!())?
        .checked_div(bn::U256::from(MARK_PRICE_PRECISION))
        .ok_or_else(math_error!())?
        .try_to_u128()
        .unwrap();

    let (_new_net_value, cost) =
        _calculate_base_asset_value_and_pnl(market.base_asset_amount, cur_net_value, &market.amm)
            .unwrap();

    Ok(cost)
}
