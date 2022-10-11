use std::cmp::{max, min};

use solana_program::msg;

use crate::controller::position::PositionDirection;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::amm::_calculate_market_open_bids_asks;
use crate::math::bn::U192;
use crate::math::casting::{cast_to_i128, cast_to_u128, Cast};
use crate::math::constants::{
    AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO_I128, AMM_TO_QUOTE_PRECISION_RATIO_I128,
    BID_ASK_SPREAD_PRECISION, BID_ASK_SPREAD_PRECISION_I128, DEFAULT_LARGE_BID_ASK_FACTOR,
    MAX_BID_ASK_INVENTORY_SKEW_FACTOR, PEG_PRECISION, PRICE_PRECISION, PRICE_PRECISION_I128,
};
use crate::math_error;
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
    let invariant = invariant_sqrt_u192
        .checked_mul(invariant_sqrt_u192)
        .ok_or_else(math_error!())?;

    validate!(limit_price > 0, ErrorCode::DefaultError, "limit_price <= 0")?;

    let new_base_asset_reserve_squared = invariant
        .checked_mul(U192::from(PRICE_PRECISION))
        .ok_or_else(math_error!())?
        .checked_div(U192::from(limit_price))
        .ok_or_else(math_error!())?
        .checked_mul(U192::from(amm.peg_multiplier))
        .ok_or_else(math_error!())?
        .checked_div(U192::from(PEG_PRECISION))
        .ok_or_else(math_error!())?;

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
            .checked_sub(base_asset_reserve_before)
            .ok_or_else(math_error!())?
            .cast::<u64>()?;
        Ok((max_trade_amount, PositionDirection::Short))
    } else {
        let max_trade_amount = base_asset_reserve_before
            .checked_sub(new_base_asset_reserve)
            .ok_or_else(math_error!())?
            .cast::<u64>()?;
        Ok((max_trade_amount, PositionDirection::Long))
    }
}

pub fn cap_to_max_spread(
    mut long_spread: u128,
    mut short_spread: u128,
    max_spread: u128,
) -> ClearingHouseResult<(u128, u128)> {
    let total_spread = long_spread
        .checked_add(short_spread)
        .ok_or_else(math_error!())?;

    if total_spread > max_spread {
        if long_spread > short_spread {
            long_spread = min(max_spread, long_spread);
            short_spread = max_spread
                .checked_sub(long_spread)
                .ok_or_else(math_error!())?;
        } else {
            short_spread = min(max_spread, short_spread);
            long_spread = max_spread
                .checked_sub(short_spread)
                .ok_or_else(math_error!())?;
        }
    }

    let new_total_spread = long_spread
        .checked_add(short_spread)
        .ok_or_else(math_error!())?;

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
                .checked_add(cast_to_u128(last_oracle_conf_pct)?)
                .ok_or_else(math_error!())?,
        );
    } else {
        short_spread = max(
            short_spread,
            last_oracle_reserve_price_spread_pct
                .unsigned_abs()
                .checked_add(cast_to_u128(last_oracle_conf_pct)?)
                .ok_or_else(math_error!())?,
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
        .checked_mul(cast_to_i128(DEFAULT_LARGE_BID_ASK_FACTOR)?)
        .ok_or_else(math_error!())?
        .checked_div(min_side_liquidity.max(1))
        .ok_or_else(math_error!())?
        .unsigned_abs();

    let inventory_scale_capped = min(
        MAX_BID_ASK_INVENTORY_SKEW_FACTOR,
        BID_ASK_SPREAD_PRECISION
            .checked_add(inventory_scale)
            .ok_or_else(math_error!())?,
    );

    if base_asset_amount_with_amm > 0 {
        long_spread = long_spread
            .checked_mul(inventory_scale_capped)
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?;
    } else if base_asset_amount_with_amm < 0 {
        short_spread = short_spread
            .checked_mul(inventory_scale_capped)
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?;
    }

    // effective leverage scale
    let net_base_asset_value = cast_to_i128(quote_asset_reserve)?
        .checked_sub(cast_to_i128(terminal_quote_asset_reserve)?)
        .ok_or_else(math_error!())?
        .checked_mul(cast_to_i128(peg_multiplier)?)
        .ok_or_else(math_error!())?
        .checked_div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO_I128)
        .ok_or_else(math_error!())?;

    let local_base_asset_value = base_asset_amount_with_amm
        .checked_mul(cast_to_i128(reserve_price)?)
        .ok_or_else(math_error!())?
        .checked_div(AMM_TO_QUOTE_PRECISION_RATIO_I128 * PRICE_PRECISION_I128)
        .ok_or_else(math_error!())?;

    let effective_leverage = max(
        0,
        local_base_asset_value
            .checked_sub(net_base_asset_value)
            .ok_or_else(math_error!())?,
    )
    .checked_mul(BID_ASK_SPREAD_PRECISION_I128)
    .ok_or_else(math_error!())?
    .checked_div(max(0, total_fee_minus_distributions) + 1)
    .ok_or_else(math_error!())?;

    let effective_leverage_capped = min(
        MAX_BID_ASK_INVENTORY_SKEW_FACTOR,
        BID_ASK_SPREAD_PRECISION
            .checked_add(cast_to_u128(max(0, effective_leverage))? + 1)
            .ok_or_else(math_error!())?,
    );

    if total_fee_minus_distributions <= 0 {
        long_spread = long_spread
            .checked_mul(DEFAULT_LARGE_BID_ASK_FACTOR)
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?;
        short_spread = short_spread
            .checked_mul(DEFAULT_LARGE_BID_ASK_FACTOR)
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?;
    } else if base_asset_amount_with_amm > 0 {
        long_spread = long_spread
            .checked_mul(effective_leverage_capped)
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?;
    } else {
        short_spread = short_spread
            .checked_mul(effective_leverage_capped)
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION)
            .ok_or_else(math_error!())?;
    }
    let (long_spread, short_spread) = cap_to_max_spread(
        long_spread,
        short_spread,
        cast_to_u128(max_spread)?.max(last_oracle_reserve_price_spread_pct.unsigned_abs()),
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
            .checked_div(BID_ASK_SPREAD_PRECISION / (spread / 2))
            .ok_or_else(math_error!())?
    } else {
        0
    };

    let quote_asset_reserve = match direction {
        PositionDirection::Long => amm
            .quote_asset_reserve
            .checked_add(quote_asset_reserve_delta)
            .ok_or_else(math_error!())?,
        PositionDirection::Short => amm
            .quote_asset_reserve
            .checked_sub(quote_asset_reserve_delta)
            .ok_or_else(math_error!())?,
    };

    let invariant_sqrt_u192 = U192::from(amm.sqrt_k);
    let invariant = invariant_sqrt_u192
        .checked_mul(invariant_sqrt_u192)
        .ok_or_else(math_error!())?;

    let base_asset_reserve = invariant
        .checked_div(U192::from(quote_asset_reserve))
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    Ok((base_asset_reserve, quote_asset_reserve))
}
