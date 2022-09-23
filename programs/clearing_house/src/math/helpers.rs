use crate::error::ClearingHouseResult;
use crate::math::bn::U192;
use crate::math::casting::{cast_to_i128, cast_to_u128};
use crate::math_error;
use solana_program::msg;

pub fn standardize_value_with_remainder_i128(
    value: i128,
    step_size: u128,
) -> ClearingHouseResult<(i128, i128)> {
    let remainder = cast_to_i128(
        value
            .unsigned_abs()
            .checked_rem_euclid(step_size)
            .ok_or_else(math_error!())?,
    )?
    .checked_mul(value.signum())
    .ok_or_else(math_error!())?;

    let standardized_value = value.checked_sub(remainder).ok_or_else(math_error!())?;

    Ok((standardized_value, remainder))
}

pub fn get_proportion_i128(
    value: i128,
    numerator: u128,
    denominator: u128,
) -> ClearingHouseResult<i128> {
    let proportional_u128 = get_proportion_u128(value.unsigned_abs(), numerator, denominator)?;
    let proportional_value = cast_to_i128(proportional_u128)?
        .checked_mul(value.signum())
        .ok_or_else(math_error!())?;

    Ok(proportional_value)
}

pub fn get_proportion_u128(
    value: u128,
    numerator: u128,
    denominator: u128,
) -> ClearingHouseResult<u128> {
    // we use u128::max.sqrt() here
    let large_constant = cast_to_u128(u64::MAX)?;

    let proportional_value = if numerator == denominator {
        value
    } else if value >= large_constant || numerator >= large_constant {
        let value = U192::from(value)
            .checked_mul(U192::from(numerator))
            .ok_or_else(math_error!())?
            .checked_div(U192::from(denominator))
            .ok_or_else(math_error!())?;

        cast_to_u128(value)?
    } else if numerator > denominator / 2 && denominator > numerator {
        // get values to ensure a ceiling division
        let (std_value, r) = standardize_value_with_remainder_i128(
            cast_to_i128(
                value
                    .checked_mul(
                        denominator
                            .checked_sub(numerator)
                            .ok_or_else(math_error!())?,
                    )
                    .ok_or_else(math_error!())?,
            )?,
            denominator,
        )?;

        // perform ceiling division by subtracting one if there is a remainder
        value
            .checked_sub(
                cast_to_u128(std_value)?
                    .checked_div(denominator)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?
            .checked_sub(cast_to_u128(r.signum())?)
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

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn proportion_tests() {
        let result = get_proportion_i128(999999999369, 1000000036297, 1000000042597).unwrap();
        assert_eq!(result, 999999993069);
        let result = get_proportion_u128(999999999369, 1000000036297, 1000000042597).unwrap();
        assert_eq!(result, 999999993069);
        let result = get_proportion_u128(1000000036297, 999999999369, 1000000042597).unwrap();
        assert_eq!(result, 999999993069);

        let result = get_proportion_u128(999999999369, 1000000042597, 1000000036297).unwrap();
        assert_eq!(result, 1000000005668);
        let result = get_proportion_u128(1000000042597, 999999999369, 1000000036297).unwrap();
        assert_eq!(result, 1000000005668);
    }
}
