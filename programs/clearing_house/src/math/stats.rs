use crate::error::ClearingHouseResult;
use crate::math::casting::{cast, cast_to_i128};
use crate::math_error;
use solana_program::msg;
use std::cmp::max;

pub fn calculate_weighted_average(
    data1: i128,
    data2: i128,
    weight1: i128,
    weight2: i128,
) -> ClearingHouseResult<i128> {
    let denominator = weight1.checked_add(weight2).ok_or_else(math_error!())?;
    let prev_twap_99 = data1.checked_mul(weight1).ok_or_else(math_error!())?;
    let latest_price_01 = data2.checked_mul(weight2).ok_or_else(math_error!())?;

    prev_twap_99
        .checked_add(latest_price_01)
        .ok_or_else(math_error!())?
        .checked_div(denominator)
        .ok_or_else(math_error!())
}

pub fn calculate_new_twap(
    current_price: u128,
    current_ts: i64,
    last_twap: u128,
    last_ts: i64,
    period: i64,
) -> ClearingHouseResult<u128> {
    let since_last = cast_to_i128(max(
        1,
        current_ts.checked_sub(last_ts).ok_or_else(math_error!())?,
    ))?;
    let from_start = max(
        1,
        cast_to_i128(period)?
            .checked_sub(since_last)
            .ok_or_else(math_error!())?,
    );

    let new_twap: u128 = cast(calculate_weighted_average(
        cast(current_price)?,
        cast(last_twap)?,
        since_last,
        from_start,
    )?)?;

    Ok(new_twap)
}
