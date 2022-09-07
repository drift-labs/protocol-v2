use crate::error::ClearingHouseResult;
use crate::math::casting::cast_to_i128;
use crate::math_error;
use solana_program::msg;

pub fn get_proportion_i128(
    value: i128,
    numerator: u128,
    denominator: u128,
) -> ClearingHouseResult<i128> {
    let proportional_value = cast_to_i128(
        value
            .unsigned_abs()
            .checked_mul(numerator)
            .ok_or_else(math_error!())?
            .checked_div(denominator)
            .ok_or_else(math_error!())?,
    )?
    .checked_mul(value.signum())
    .ok_or_else(math_error!())?;
    Ok(proportional_value)
}

pub fn get_proportion_u128(
    value: u128,
    numerator: u128,
    denominator: u128,
) -> ClearingHouseResult<u128> {
    let proportional_value = if numerator > denominator / 2 && denominator >= numerator {
        value
            .checked_sub(
                value
                    .checked_mul(denominator - numerator)
                    .ok_or_else(math_error!())?
                    .checked_div(denominator)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?
    } else {
        value
            .checked_mul(numerator)
            .ok_or_else(math_error!())?
            .checked_div(denominator)
            .ok_or_else(math_error!())?
    };

    Ok(proportional_value)
}

pub fn on_the_hour_update(
    now: i64,
    last_update_ts: i64,
    update_period: i64,
) -> ClearingHouseResult<i64> {
    let time_since_last_update = now.checked_sub(last_update_ts).ok_or_else(math_error!())?;

    // round next update time to be available on the hour
    let mut next_update_wait = update_period;
    if update_period > 1 {
        let last_update_delay = last_update_ts.rem_euclid(update_period);
        if last_update_delay != 0 {
            let max_delay_for_next_period =
                update_period.checked_div(3).ok_or_else(math_error!())?;

            let two_funding_periods = update_period.checked_mul(2).ok_or_else(math_error!())?;

            if last_update_delay > max_delay_for_next_period {
                // too late for on the hour next period, delay to following period
                next_update_wait = two_funding_periods
                    .checked_sub(last_update_delay)
                    .ok_or_else(math_error!())?;
            } else {
                // allow update on the hour
                next_update_wait = update_period
                    .checked_sub(last_update_delay)
                    .ok_or_else(math_error!())?;
            }

            if next_update_wait > two_funding_periods {
                next_update_wait = next_update_wait
                    .checked_sub(update_period)
                    .ok_or_else(math_error!())?;
            }
        }
    }

    let time_remaining_until_update = next_update_wait
        .checked_sub(time_since_last_update)
        .ok_or_else(math_error!())?
        .max(0);

    Ok(time_remaining_until_update)
}
