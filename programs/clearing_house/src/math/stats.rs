use crate::error::ClearingHouseResult;
use crate::math::casting::{cast_to_i128, cast_to_u128, cast_to_u64};
use crate::math_error;
use solana_program::msg;
use std::cmp::max;

pub fn calculate_rolling_sum(
    data1: u64,
    data2: u64,
    weight1_numer: i128,
    weight1_denom: i128,
) -> ClearingHouseResult<u64> {
    // assumes that missing times are zeros (e.g. handle NaN as 0)
    let prev_twap_99 = cast_to_u128(data1)?
        .checked_mul(cast_to_u128(max(
            0,
            weight1_denom
                .checked_sub(weight1_numer)
                .ok_or_else(math_error!())?,
        ))?)
        .ok_or_else(math_error!())?
        .checked_div(cast_to_u128(weight1_denom)?)
        .ok_or_else(math_error!())?;

    cast_to_u64(prev_twap_99)?
        .checked_add(data2)
        .ok_or_else(math_error!())
}

pub fn calculate_weighted_average(
    data1: i128,
    data2: i128,
    weight1: i128,
    weight2: i128,
) -> ClearingHouseResult<i128> {
    let denominator = weight1.checked_add(weight2).ok_or_else(math_error!())?;
    let prev_twap_99 = data1.checked_mul(weight1).ok_or_else(math_error!())?;
    let latest_price_01 = data2.checked_mul(weight2).ok_or_else(math_error!())?;

    let bias: i128 = if weight2 > 1 {
        if latest_price_01 < prev_twap_99 {
            -1
        } else if latest_price_01 > prev_twap_99 {
            1
        } else {
            0
        }
    } else {
        0
    };

    let twap = prev_twap_99
        .checked_add(latest_price_01)
        .ok_or_else(math_error!())?
        .checked_div(denominator)
        .ok_or_else(math_error!())?;

    if twap == 0 && bias < 0 {
        return Ok(twap);
    }

    twap.checked_add(bias).ok_or_else(math_error!())
}

pub fn calculate_new_twap(
    current_price: i128,
    current_ts: i64,
    last_twap: i128,
    last_ts: i64,
    period: i64,
) -> ClearingHouseResult<i128> {
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

    let new_twap: i128 =
        calculate_weighted_average(current_price, last_twap, since_last, from_start)?;

    Ok(new_twap)
}
