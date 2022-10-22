use std::cmp::{max, min};

use solana_program::msg;

use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::amm::_calculate_market_open_bids_asks;
use crate::math::bn::U192;
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO_I128, AMM_TO_QUOTE_PRECISION_RATIO_I128,
    BID_ASK_SPREAD_PRECISION, BID_ASK_SPREAD_PRECISION_I128, DEFAULT_LARGE_BID_ASK_FACTOR,
    MAX_BID_ASK_INVENTORY_SKEW_FACTOR, PEG_PRECISION, PRICE_PRECISION, PRICE_PRECISION_I128,
};
use crate::math::safe_math::SafeMath;

use crate::state::perp_market::AMM;
use crate::validate;

#[cfg(test)]
mod tests;

pub fn calculate_base_asset_amount_to_trade_to_price(
    amm: &AMM,
    limit_price: u128,
    direction: PositionDirection,
) -> ClearingHouseResult<(u64, PositionDirection)> {
    let invariant_sqrt_u192 = U192::from(amm.sqrt_k);
    let invariant = invariant_sqrt_u192.safe_mul(invariant_sqrt_u192)?;

    validate!(limit_price > 0, ErrorCode::DefaultError, "limit_price <= 0")?;

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
            .cast::<u64>()?;
        Ok((max_trade_amount, PositionDirection::Short))
    } else {
        let max_trade_amount = base_asset_reserve_before
            .safe_sub(new_base_asset_reserve)?
            .cast::<u64>()?;
        Ok((max_trade_amount, PositionDirection::Long))
    }
}

pub fn cap_to_max_spread(
    mut long_spread: u128,
    mut short_spread: u128,
    max_spread: u128,
) -> ClearingHouseResult<(u128, u128)> {
    let total_spread = long_spread.safe_add(short_spread)?;

    if total_spread > max_spread {
        if long_spread > short_spread {
            long_spread = min(max_spread, long_spread);
            short_spread = max_spread.safe_sub(long_spread)?;
        } else {
            short_spread = min(max_spread, short_spread);
            long_spread = max_spread.safe_sub(short_spread)?;
        }
    }

    let new_total_spread = long_spread.safe_add(short_spread)?;

    validate!(
        new_total_spread <= max_spread,
        ErrorCode::DefaultError,
        "new_total_spread({}) > max_spread({})",
        new_total_spread,
        max_spread
    )?;

    Ok((long_spread, short_spread))
}

#[allow(clippy::comparison_chain)]
pub fn calculate_spread(
    base_spread: u16,
    last_oracle_reserve_price_spread_pct: i128,
    last_oracle_conf_pct: u64,
    max_spread: u32,
    quote_asset_reserve: u128,
    terminal_quote_asset_reserve: u128,
    peg_multiplier: u128,
    base_asset_amount_with_amm: i128,
    reserve_price: u128,
    total_fee_minus_distributions: i128,
    base_asset_reserve: u128,
    min_base_asset_reserve: u128,
    max_base_asset_reserve: u128,
) -> ClearingHouseResult<(u128, u128)> {
    let mut long_spread = (base_spread / 2) as u128;
    let mut short_spread = (base_spread / 2) as u128;

    // oracle retreat
    // if mark - oracle < 0 (mark below oracle) and user going long then increase spread
    if last_oracle_reserve_price_spread_pct < 0 {
        long_spread = max(
            long_spread,
            last_oracle_reserve_price_spread_pct
                .unsigned_abs()
                .safe_add(last_oracle_conf_pct.cast::<u128>()?)?,
        );
    } else {
        short_spread = max(
            short_spread,
            last_oracle_reserve_price_spread_pct
                .unsigned_abs()
                .safe_add(last_oracle_conf_pct.cast::<u128>()?)?,
        );
    }

    // inventory scale
    let (max_bids, max_asks) = _calculate_market_open_bids_asks(
        base_asset_reserve,
        min_base_asset_reserve,
        max_base_asset_reserve,
    )?;

    let min_side_liquidity = max_bids.min(max_asks.abs());

    // inventory scale
    let inventory_scale = base_asset_amount_with_amm
        .safe_mul(DEFAULT_LARGE_BID_ASK_FACTOR.cast::<i128>()?)?
        .safe_div(min_side_liquidity.max(1))?
        .unsigned_abs();

    let inventory_scale_capped = min(
        MAX_BID_ASK_INVENTORY_SKEW_FACTOR,
        BID_ASK_SPREAD_PRECISION.safe_add(inventory_scale)?,
    );

    if base_asset_amount_with_amm > 0 {
        long_spread = long_spread
            .safe_mul(inventory_scale_capped)?
            .safe_div(BID_ASK_SPREAD_PRECISION)?;
    } else if base_asset_amount_with_amm < 0 {
        short_spread = short_spread
            .safe_mul(inventory_scale_capped)?
            .safe_div(BID_ASK_SPREAD_PRECISION)?;
    }

    // effective leverage scale
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
        BID_ASK_SPREAD_PRECISION.safe_add(max(0, effective_leverage).cast::<u128>()? + 1)?,
    );

    if total_fee_minus_distributions <= 0 {
        long_spread = long_spread
            .safe_mul(DEFAULT_LARGE_BID_ASK_FACTOR)?
            .safe_div(BID_ASK_SPREAD_PRECISION)?;
        short_spread = short_spread
            .safe_mul(DEFAULT_LARGE_BID_ASK_FACTOR)?
            .safe_div(BID_ASK_SPREAD_PRECISION)?;
    } else if base_asset_amount_with_amm > 0 {
        long_spread = long_spread
            .safe_mul(effective_leverage_capped)?
            .safe_div(BID_ASK_SPREAD_PRECISION)?;
    } else {
        short_spread = short_spread
            .safe_mul(effective_leverage_capped)?
            .safe_div(BID_ASK_SPREAD_PRECISION)?;
    }
    let (long_spread, short_spread) = cap_to_max_spread(
        long_spread,
        short_spread,
        max_spread
            .cast::<u128>()?
            .max(last_oracle_reserve_price_spread_pct.unsigned_abs()),
    )?;

    Ok((long_spread, short_spread))
}

pub fn get_spread_reserves(
    amm: &AMM,
    direction: PositionDirection,
) -> ClearingHouseResult<(u128, u128)> {
    let (base_asset_reserve, quote_asset_reserve) = match direction {
        PositionDirection::Long => (amm.ask_base_asset_reserve, amm.ask_quote_asset_reserve),
        PositionDirection::Short => (amm.bid_base_asset_reserve, amm.bid_quote_asset_reserve),
    };

    Ok((base_asset_reserve, quote_asset_reserve))
}

pub fn calculate_spread_reserves(
    amm: &AMM,
    direction: PositionDirection,
) -> ClearingHouseResult<(u128, u128)> {
    let spread = match direction {
        PositionDirection::Long => amm.long_spread,
        PositionDirection::Short => amm.short_spread,
    };

    let quote_asset_reserve_delta = if spread > 0 {
        amm.quote_asset_reserve
            .safe_div(BID_ASK_SPREAD_PRECISION / (spread / 2))?
    } else {
        0
    };

    let quote_asset_reserve = match direction {
        PositionDirection::Long => amm
            .quote_asset_reserve
            .safe_add(quote_asset_reserve_delta)?,
        PositionDirection::Short => amm
            .quote_asset_reserve
            .safe_sub(quote_asset_reserve_delta)?,
    };

    let invariant_sqrt_u192 = U192::from(amm.sqrt_k);
    let invariant = invariant_sqrt_u192.safe_mul(invariant_sqrt_u192)?;

    let base_asset_reserve = invariant
        .safe_div(U192::from(quote_asset_reserve))?
        .try_to_u128()?;

    Ok((base_asset_reserve, quote_asset_reserve))
}
