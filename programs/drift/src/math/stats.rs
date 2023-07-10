use crate::error::DriftResult;
use crate::math::casting::Cast;
use crate::math::safe_math::SafeMath;
use std::cmp::max;

pub fn calculate_rolling_sum(
    data1: u64,
    data2: u64,
    weight1_numer: i64,
    weight1_denom: i64,
) -> DriftResult<u64> {
    // assumes that missing times are zeros (e.g. handle NaN as 0)
    let prev_twap_99 = data1
        .cast::<u128>()?
        .safe_mul(max(0, weight1_denom.safe_sub(weight1_numer)?).cast::<u128>()?)?
        .safe_div(weight1_denom.cast::<u128>()?)?;

    prev_twap_99.cast::<u64>()?.safe_add(data2)
}

pub fn calculate_weighted_average(
    data1: i64,
    data2: i64,
    weight1: i64,
    weight2: i64,
) -> DriftResult<i64> {
    let denominator = weight1.safe_add(weight2)?.cast::<i128>()?;
    let prev_twap_99 = data1.cast::<i128>()?.safe_mul(weight1.cast()?)?;
    let latest_price_01 = data2.cast::<i128>()?.safe_mul(weight2.cast()?)?;

    if weight1 == 0 {
        return Ok(data2);
    }

    if weight2 == 0 {
        return Ok(data1);
    }

    let bias: i64 = if weight2 > 1 {
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
        .safe_add(latest_price_01)?
        .safe_div(denominator)?
        .cast::<i64>()?;

    if twap == 0 && bias < 0 {
        return Ok(twap);
    }

    twap.safe_add(bias)
}

pub fn calculate_new_twap(
    current_price: i64,
    current_ts: i64,
    last_twap: i64,
    last_ts: i64,
    period: i64,
) -> DriftResult<i64> {
    let since_last = max(0_i64, current_ts.safe_sub(last_ts)?);
    let from_start = max(1_i64, period.safe_sub(since_last)?);

    calculate_weighted_average(current_price, last_twap, since_last, from_start)
}
