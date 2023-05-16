use crate::error::DriftResult;
use crate::math::safe_math::SafeMath;
use crate::PRICE_PRECISION;

pub fn calculate_swap_price(
    asset_amount: u128,
    liability_amount: u128,
    asset_decimals: u32,
    liability_decimals: u32,
) -> DriftResult<u128> {
    asset_amount
        .safe_mul(PRICE_PRECISION)?
        .safe_div(10_u128.pow(asset_decimals))?
        .safe_mul(10_u128.pow(liability_decimals))?
        .safe_div(liability_amount)
}
