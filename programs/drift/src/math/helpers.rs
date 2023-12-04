use solana_program::msg;

use crate::error::DriftResult;
use crate::math::bn::U192;
use crate::math::casting::Cast;
use crate::math::safe_math::SafeMath;
use crate::math_error;

#[cfg(test)]
mod tests;

pub fn standardize_value_with_remainder_i128(
    value: i128,
    step_size: u128,
) -> DriftResult<(i128, i128)> {
    let remainder = value
        .unsigned_abs()
        .checked_rem_euclid(step_size)
        .ok_or_else(math_error!())?
        .cast::<i128>()?
        .safe_mul(value.signum())?;

    let standardized_value = value.safe_sub(remainder)?;

    Ok((standardized_value, remainder))
}

pub fn get_proportion_i128(value: i128, numerator: u128, denominator: u128) -> DriftResult<i128> {
    let proportional_u128 = get_proportion_u128(value.unsigned_abs(), numerator, denominator)?;
    let proportional_value = proportional_u128.cast::<i128>()?.safe_mul(value.signum())?;

    Ok(proportional_value)
}

pub fn get_proportion_u128(value: u128, numerator: u128, denominator: u128) -> DriftResult<u128> {
    // we use u128::max.sqrt() here
    let large_constant = u64::MAX.cast::<u128>()?;

    let proportional_value = if numerator == denominator {
        value
    } else if value >= large_constant || numerator >= large_constant {
        let value = U192::from(value)
            .safe_mul(U192::from(numerator))?
            .safe_div(U192::from(denominator))?;

        value.cast::<u128>()?
    } else if numerator > denominator / 2 && denominator > numerator {
        // get values to ensure a ceiling division
        let (std_value, r) = standardize_value_with_remainder_i128(
            value
                .safe_mul(denominator.safe_sub(numerator)?)?
                .cast::<i128>()?,
            denominator,
        )?;

        // perform ceiling division by subtracting one if there is a remainder
        value
            .safe_sub(std_value.cast::<u128>()?.safe_div(denominator)?)?
            .safe_sub(r.signum().cast::<u128>()?)?
    } else {
        value.safe_mul(numerator)?.safe_div(denominator)?
    };

    Ok(proportional_value)
}

pub fn on_the_hour_update(now: i64, last_update_ts: i64, update_period: i64) -> DriftResult<i64> {
    let time_since_last_update = now.safe_sub(last_update_ts)?;

    // round next update time to be available on the hour
    let mut next_update_wait = update_period;
    if update_period > 1 {
        let last_update_delay = last_update_ts.rem_euclid(update_period);
        if last_update_delay != 0 {
            let max_delay_for_next_period = update_period.safe_div(3)?;

            let two_funding_periods = update_period.safe_mul(2)?;

            if last_update_delay > max_delay_for_next_period {
                // too late for on the hour next period, delay to following period
                next_update_wait = two_funding_periods.safe_sub(last_update_delay)?;
            } else {
                // allow update on the hour
                next_update_wait = update_period.safe_sub(last_update_delay)?;
            }

            if next_update_wait > two_funding_periods {
                next_update_wait = next_update_wait.safe_sub(update_period)?;
            }
        }
    }

    let time_remaining_until_update = next_update_wait.safe_sub(time_since_last_update)?.max(0);

    Ok(time_remaining_until_update)
}

#[cfg(test)]
#[allow(clippy::comparison_chain)]
pub fn log10(n: u128) -> u128 {
    if n < 10 {
        0
    } else if n == 10 {
        1
    } else {
        log10(n / 10) + 1
    }
}

pub fn log10_iter(n: u128) -> u128 {
    let mut result = 0;
    let mut n_copy = n;

    while n_copy >= 10 {
        result += 1;
        n_copy /= 10;
    }

    result
}
