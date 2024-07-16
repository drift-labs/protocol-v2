use crate::error::DriftResult;
use crate::math::casting::Cast;
use crate::math::safe_math::SafeMath;
use crate::state::perp_market::PerpMarket;
use crate::state::spot_market::SpotMarket;
use crate::{FUEL_WINDOW_U128, QUOTE_PRECISION, QUOTE_PRECISION_U64};

#[cfg(test)]
mod tests;

pub fn calculate_perp_fuel_bonus(
    perp_market: &PerpMarket,
    base_asset_value: i128,
    fuel_bonus_numerator: i64,
) -> DriftResult<u64> {
    let result: u64 = if base_asset_value.unsigned_abs() < QUOTE_PRECISION {
        0_u64
    } else {
        base_asset_value
            .unsigned_abs()
            .safe_mul(fuel_bonus_numerator.cast()?)?
            .safe_mul(perp_market.fuel_boost_position.cast()?)?
            .safe_div(FUEL_WINDOW_U128)?
            .cast::<u64>()?
            / (QUOTE_PRECISION_U64 / 10)
    };

    Ok(result)
}

pub fn calculate_spot_fuel_bonus(
    spot_market: &SpotMarket,
    signed_token_value: i128,
    fuel_bonus_numerator: i64,
) -> DriftResult<u64> {
    let result: u64 = if signed_token_value.unsigned_abs() < QUOTE_PRECISION {
        0_u64
    } else if signed_token_value > 0 {
        signed_token_value
            .unsigned_abs()
            .safe_mul(fuel_bonus_numerator.cast()?)?
            .safe_mul(spot_market.fuel_boost_deposits.cast()?)?
            .safe_div(FUEL_WINDOW_U128)?
            .cast::<u64>()?
            / (QUOTE_PRECISION_U64 / 10)
    } else {
        signed_token_value
            .unsigned_abs()
            .safe_mul(fuel_bonus_numerator.cast()?)?
            .safe_mul(spot_market.fuel_boost_borrows.cast()?)?
            .safe_div(FUEL_WINDOW_U128)?
            .cast::<u64>()?
            / (QUOTE_PRECISION_U64 / 10)
    };

    Ok(result)
}
