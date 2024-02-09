use crate::controller::amm::SwapDirection;
use crate::controller::position::PositionDelta;
use crate::error::DriftResult;
use crate::math::amm;
use crate::math::amm::calculate_quote_asset_amount_swapped;
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_RESERVE_PRECISION_I128, PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO,
    PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128,
};
use crate::math::helpers::get_proportion_u128;
use crate::math::pnl::calculate_pnl;
use crate::math::safe_math::SafeMath;

use crate::state::perp_market::AMM;
use crate::state::user::PerpPosition;

pub fn calculate_base_asset_value_and_pnl(
    base_asset_amount: i128,
    quote_asset_amount: u128,
    amm: &AMM,
) -> DriftResult<(u128, i128)> {
    if base_asset_amount == 0 {
        return Ok((0, 0));
    }
    let swap_direction = swap_direction_to_close_position(base_asset_amount);
    let base_asset_value = calculate_base_asset_value(base_asset_amount, amm)?;
    let pnl = calculate_pnl(base_asset_value, quote_asset_amount, swap_direction)?;

    Ok((base_asset_value, pnl))
}

pub fn calculate_base_asset_value(base_asset_amount: i128, amm: &AMM) -> DriftResult<u128> {
    if base_asset_amount == 0 {
        return Ok(0);
    }

    let swap_direction = swap_direction_to_close_position(base_asset_amount);

    let (base_asset_reserve, quote_asset_reserve) =
        (amm.base_asset_reserve, amm.quote_asset_reserve);

    let amm_lp_shares = amm.sqrt_k.safe_sub(amm.user_lp_shares)?;

    let base_asset_reserve_proportion =
        get_proportion_u128(base_asset_reserve, amm_lp_shares, amm.sqrt_k)?;

    let quote_asset_reserve_proportion =
        get_proportion_u128(quote_asset_reserve, amm_lp_shares, amm.sqrt_k)?;

    let (new_quote_asset_reserve, _new_base_asset_reserve) = amm::calculate_swap_output(
        base_asset_amount.unsigned_abs(),
        base_asset_reserve_proportion,
        swap_direction,
        amm_lp_shares,
    )?;

    let base_asset_value = calculate_quote_asset_amount_swapped(
        quote_asset_reserve_proportion,
        new_quote_asset_reserve,
        swap_direction,
        amm.peg_multiplier,
    )?;

    Ok(base_asset_value)
}

pub fn calculate_base_asset_value_with_oracle_price(
    base_asset_amount: i128,
    oracle_price: i64,
) -> DriftResult<u128> {
    if base_asset_amount == 0 {
        return Ok(0);
    }

    let oracle_price = if oracle_price > 0 {
        oracle_price.unsigned_abs()
    } else {
        0
    };

    base_asset_amount
        .unsigned_abs()
        .safe_mul(oracle_price.cast()?)?
        .safe_div(PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO)
}

pub fn calculate_base_asset_value_and_pnl_with_oracle_price(
    market_position: &PerpPosition,
    oracle_price: i64,
) -> DriftResult<(u128, i128)> {
    if market_position.base_asset_amount == 0 {
        return Ok((0, market_position.quote_asset_amount.cast()?));
    }

    let oracle_price = if oracle_price > 0 {
        oracle_price.abs()
    } else {
        0
    };

    let base_asset_value = market_position
        .base_asset_amount
        .cast::<i128>()?
        .safe_mul(oracle_price.cast()?)?
        .safe_div(AMM_RESERVE_PRECISION_I128)?;

    let pnl = base_asset_value.safe_add(market_position.quote_asset_amount.cast()?)?;

    Ok((base_asset_value.unsigned_abs(), pnl))
}

pub fn calculate_base_asset_value_with_expiry_price(
    market_position: &PerpPosition,
    expiry_price: i64,
) -> DriftResult<i64> {
    if market_position.base_asset_amount == 0 {
        return Ok(0);
    }

    market_position
        .base_asset_amount
        .cast::<i128>()?
        .safe_mul(expiry_price.cast()?)?
        .safe_div(PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128)?
        .cast::<i64>()
}

pub fn swap_direction_to_close_position(base_asset_amount: i128) -> SwapDirection {
    if base_asset_amount >= 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    }
}

pub enum PositionUpdateType {
    Open,
    Increase,
    Reduce,
    Close,
    Flip,
}
pub fn get_position_update_type(
    position: &PerpPosition,
    delta: &PositionDelta,
) -> DriftResult<PositionUpdateType> {
    if position.base_asset_amount == 0 && position.remainder_base_asset_amount == 0 {
        crate::msg!("open");
        return Ok(PositionUpdateType::Open);
    }

    let delta_base_with_remainder =
        if let Some(remainder_base_asset_amount) = delta.remainder_base_asset_amount {
            delta
                .base_asset_amount
                .safe_add(remainder_base_asset_amount.cast()?)?
        } else {
            delta.base_asset_amount
        };

    if position.base_asset_amount.signum() == delta_base_with_remainder.signum() {
        crate::msg!("inc");

        return Ok(PositionUpdateType::Increase);
    } else if position.base_asset_amount.abs() > delta_base_with_remainder.abs() {
        crate::msg!("red");

        return Ok(PositionUpdateType::Reduce);
    } else if position.base_asset_amount.abs() == delta_base_with_remainder.abs() {
        crate::msg!("close");

        return Ok(PositionUpdateType::Close);
    } else {
        crate::msg!("flip");

        return Ok(PositionUpdateType::Flip);
    }
}
