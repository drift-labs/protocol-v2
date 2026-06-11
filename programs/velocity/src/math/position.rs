use crate::controller::position::PositionDelta;
use crate::error::VelocityResult;
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_RESERVE_PRECISION_I128, PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO,
    PRICE_TIMES_AMM_TO_QUOTE_PRECISION_RATIO_I128,
};
use crate::math::safe_math::SafeMath;
use crate::vlp::amm::controller::SwapDirection;

use crate::state::user::PerpPosition;

pub fn calculate_base_asset_value_with_oracle_price(
    base_asset_amount: i128,
    oracle_price: i64,
) -> VelocityResult<u128> {
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

pub fn calculate_perp_liability_value(
    base_asset_amount: i128,
    oracle_price: i64,
) -> VelocityResult<u128> {
    calculate_base_asset_value_with_oracle_price(base_asset_amount, oracle_price)
}

pub fn calculate_base_asset_value_and_pnl_with_oracle_price(
    market_position: &PerpPosition,
    oracle_price: i64,
) -> VelocityResult<(u128, i128)> {
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
) -> VelocityResult<i64> {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
) -> VelocityResult<PositionUpdateType> {
    if position.base_asset_amount == 0 {
        return Ok(PositionUpdateType::Open);
    }

    let position_base = position.base_asset_amount;

    let delta_base = delta.base_asset_amount;

    if position_base.signum() == delta_base.signum() {
        Ok(PositionUpdateType::Increase)
    } else if position_base.abs() > delta_base.abs() {
        Ok(PositionUpdateType::Reduce)
    } else if position_base.abs() == delta_base.abs() {
        Ok(PositionUpdateType::Close)
    } else {
        Ok(PositionUpdateType::Flip)
    }
}

pub fn get_new_position_amounts(
    position: &PerpPosition,
    delta: &PositionDelta,
) -> VelocityResult<(i64, i64)> {
    let new_quote_asset_amount = position
        .quote_asset_amount
        .safe_add(delta.quote_asset_amount)?;

    let new_base_asset_amount = position
        .base_asset_amount
        .safe_add(delta.base_asset_amount)?;

    Ok((new_base_asset_amount, new_quote_asset_amount))
}
