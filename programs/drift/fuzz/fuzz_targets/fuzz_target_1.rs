#![no_main]

use crate::arbitrary::Arbitrary;
use drift::controller::position::update_position_and_market;
use drift::controller::position::PositionDelta;
use drift::state::perp_market::{PerpMarket, AMM};
use drift::state::user::PerpPosition;
use libfuzzer_sys::arbitrary;
use libfuzzer_sys::fuzz_target;

#[derive(Debug, Clone, Copy)]
struct Data {
    pub perp_position: PerpPosition,
    pub perp_market: PerpMarket,
    pub delta: PositionDelta,
}

impl<'a> Arbitrary<'a> for Data {
    fn arbitrary(u: &mut arbitrary::Unstructured<'a>) -> arbitrary::Result<Self> {
        let cumulative_funding_rate_long = arbitrary_i64(u)?.min(i64::MAX).max(i64::MIN) as i128;
        let cumulative_funding_rate_short = arbitrary_i64(u)?.min(i64::MAX).max(i64::MIN) as i128;

        let position_base_asset_amount = arbitrary_i64(u)?;
        let position_quote_asset_amount = arbitrary_i64(u)?;
        let mut position_last_cumulative_funding_rate = 0_i128;
        if position_base_asset_amount > 0 {
            position_last_cumulative_funding_rate = cumulative_funding_rate_long;
        } else if position_base_asset_amount < 0 {
            position_last_cumulative_funding_rate = cumulative_funding_rate_short;
        }

        let mut number_of_users_with_base = u32::arbitrary(u)?.min(u32::MAX - 1);
        if position_base_asset_amount != 0 {
            number_of_users_with_base = number_of_users_with_base.max(1);
        }

        let mut number_of_users = u32::arbitrary(u)?.min(u32::MAX - 1);
        if position_base_asset_amount != 0 || position_quote_asset_amount != 0 {
            number_of_users = number_of_users.max(1);
        }

        let perp_market = PerpMarket {
            amm: AMM {
                base_asset_amount_long: arbitrary_i128(u)?.abs(),
                base_asset_amount_short: -arbitrary_i128(u)?.abs(),
                quote_asset_amount: arbitrary_i128(u)?,
                quote_entry_amount_long: arbitrary_i128(u)?,
                quote_entry_amount_short: arbitrary_i128(u)?,
                quote_break_even_amount_long: arbitrary_i128(u)?,
                quote_break_even_amount_short: arbitrary_i128(u)?,
                order_step_size: 1,
                cumulative_funding_rate_long,
                cumulative_funding_rate_short,
                ..AMM::default()
            },
            number_of_users_with_base,
            number_of_users,
            ..PerpMarket::default()
        };
        let perp_position = PerpPosition {
            base_asset_amount: position_base_asset_amount,
            quote_asset_amount: position_quote_asset_amount,
            quote_break_even_amount: arbitrary_i64(u)?,
            quote_entry_amount: arbitrary_i64(u)?,
            last_cumulative_funding_rate: position_last_cumulative_funding_rate as i64,
            ..PerpPosition::default()
        };
        let base_asset_amount = arbitrary_i64(u)?;

        let quote_asset_amount = if base_asset_amount >= 0 {
            -arbitrary_i64(u)?.abs().max(1)
        } else {
            arbitrary_i64(u)?.abs().max(1)
        };

        let delta = PositionDelta {
            base_asset_amount,
            quote_asset_amount,
        };

        Ok(Self {
            perp_position,
            perp_market,
            delta,
        })
    }
}

fn arbitrary_i128(u: &mut arbitrary::Unstructured) -> arbitrary::Result<i128> {
    let v = i128::arbitrary(u)?;
    if v > 0 {
        Ok(v.min(1 << 120))
    } else {
        Ok(v.max(-1 << 120))
    }
}

fn arbitrary_i64(u: &mut arbitrary::Unstructured) -> arbitrary::Result<i64> {
    let v = i64::arbitrary(u)?;
    if v > 0 {
        Ok(v.min(1 << 56))
    } else {
        Ok(v.max(-1 << 56))
    }
}

fuzz_target!(|data: Data| {
    // fuzzed code goes here
    fuzz(data);
});

fn fuzz(data: Data) {
    let perp_position_before = data.perp_position.clone();
    let perp_market_before = data.perp_market.clone();

    let mut perp_position_after = data.perp_position.clone();
    let mut perp_market_after = data.perp_market.clone();
    let delta = data.delta.clone();

    update_position_and_market(&mut perp_position_after, &mut perp_market_after, &delta).unwrap();

    validate_user_position(
        &perp_position_before,
        &perp_position_after,
        &perp_market_after,
        &delta,
    );

    validate_perp_market(
        &perp_position_before,
        &perp_position_after,
        &perp_market_before,
        &perp_market_after,
        &delta,
    );
}

fn validate_user_position(
    perp_position_before: &PerpPosition,
    perp_position_after: &PerpPosition,
    perp_market_after: &PerpMarket,
    delta: &PositionDelta,
) {
    let expected_base_asset_amount =
        perp_position_before.base_asset_amount + delta.base_asset_amount;
    assert_eq!(
        perp_position_after.base_asset_amount,
        expected_base_asset_amount
    );

    let expected_quote_asset_amount =
        perp_position_before.quote_asset_amount + delta.quote_asset_amount;
    assert_eq!(
        perp_position_after.quote_asset_amount,
        expected_quote_asset_amount
    );

    if delta.base_asset_amount != 0 {
        let new_quote_entry_amount;
        let new_quote_break_even_amount;

        if perp_position_before.base_asset_amount == 0
            || perp_position_before.base_asset_amount.signum() == delta.base_asset_amount.signum()
        {
            new_quote_entry_amount =
                perp_position_before.quote_entry_amount + delta.quote_asset_amount;
            new_quote_break_even_amount =
                perp_position_before.quote_break_even_amount + delta.quote_asset_amount;
        } else if perp_position_before.base_asset_amount.abs() >= delta.base_asset_amount.abs() {
            new_quote_entry_amount = perp_position_before.quote_entry_amount
                - (perp_position_before.quote_entry_amount as i128
                    * delta.base_asset_amount.abs() as i128
                    / perp_position_before.base_asset_amount.abs() as i128)
                    as i64;
            new_quote_break_even_amount = perp_position_before.quote_break_even_amount
                - (perp_position_before.quote_break_even_amount as i128
                    * delta.base_asset_amount.abs() as i128
                    / perp_position_before.base_asset_amount.abs() as i128)
                    as i64;
        } else {
            new_quote_entry_amount = delta.quote_asset_amount
                - (delta.quote_asset_amount as i128
                    * perp_position_before.base_asset_amount.abs() as i128
                    / delta.base_asset_amount.abs() as i128) as i64;
            new_quote_break_even_amount = new_quote_entry_amount;
        }

        assert_eq!(
            perp_position_after.quote_entry_amount,
            new_quote_entry_amount
        );

        assert_eq!(
            perp_position_after.quote_break_even_amount,
            new_quote_break_even_amount
        );
    }

    if perp_position_after.base_asset_amount > 0 {
        assert!(
            perp_position_after.last_cumulative_funding_rate as i128
                == perp_market_after.amm.cumulative_funding_rate_long
        )
    } else if perp_position_after.base_asset_amount < 0 {
        assert!(
            perp_position_after.last_cumulative_funding_rate as i128
                == perp_market_after.amm.cumulative_funding_rate_short
        )
    } else {
        assert!(perp_position_after.last_cumulative_funding_rate == 0)
    }
}

fn validate_perp_market(
    perp_position_before: &PerpPosition,
    perp_position_after: &PerpPosition,
    perp_market_before: &PerpMarket,
    perp_market_after: &PerpMarket,
    delta: &PositionDelta,
) {
    if perp_position_before.base_asset_amount == 0 && perp_position_before.quote_asset_amount == 0 {
        let expected_number_of_users = perp_market_before.number_of_users + 1;
        assert_eq!(perp_market_after.number_of_users, expected_number_of_users);
    }

    if perp_position_after.base_asset_amount == 0 && perp_position_after.quote_asset_amount == 0 {
        let expected_number_of_users = perp_market_before.number_of_users - 1;
        assert_eq!(perp_market_after.number_of_users, expected_number_of_users);
    }

    if perp_position_before.base_asset_amount == 0 && delta.base_asset_amount != 0 {
        let expected_number_of_users_with_base = perp_market_before.number_of_users_with_base + 1;
        assert_eq!(
            perp_market_after.number_of_users_with_base,
            expected_number_of_users_with_base
        );
    }

    if perp_position_after.base_asset_amount == 0 && delta.base_asset_amount != 0 {
        let expected_number_of_users_with_base = perp_market_before.number_of_users_with_base - 1;
        assert_eq!(
            perp_market_after.number_of_users_with_base,
            expected_number_of_users_with_base
        );
    }

    let expected_amm_quote_asset_amount =
        perp_market_before.amm.quote_asset_amount + delta.quote_asset_amount as i128;
    assert_eq!(
        perp_market_after.amm.quote_asset_amount,
        expected_amm_quote_asset_amount
    );

    let mut amm_base_asset_amount_long_delta = 0;
    let mut amm_base_asset_amount_short_delta = 0;
    let mut amm_quote_entry_amount_long_delta = 0;
    let mut amm_quote_entry_amount_short_delta = 0;
    let mut amm_quote_break_even_amount_long_delta = 0;
    let mut amm_quote_break_even_amount_short_delta = 0;

    if delta.base_asset_amount > 0 {
        if perp_position_before.base_asset_amount >= 0 {
            amm_base_asset_amount_long_delta = delta.base_asset_amount as i128;
            amm_quote_entry_amount_long_delta = delta.quote_asset_amount as i128;
            amm_quote_break_even_amount_long_delta = delta.quote_asset_amount as i128;
        } else {
            if delta.base_asset_amount.abs() <= perp_position_before.base_asset_amount.abs() {
                amm_base_asset_amount_short_delta = delta.base_asset_amount as i128;
                amm_quote_entry_amount_short_delta = -(perp_position_before.quote_entry_amount
                    - perp_position_after.quote_entry_amount)
                    as i128;
                amm_quote_break_even_amount_short_delta =
                    -(perp_position_before.quote_break_even_amount
                        - perp_position_after.quote_break_even_amount) as i128;
            } else {
                amm_base_asset_amount_short_delta =
                    perp_position_before.base_asset_amount.abs() as i128;
                amm_base_asset_amount_long_delta = (delta.base_asset_amount
                    - perp_position_before.base_asset_amount.abs())
                    as i128;

                amm_quote_entry_amount_short_delta =
                    -perp_position_before.quote_entry_amount as i128;
                amm_quote_entry_amount_long_delta = perp_position_after.quote_entry_amount as i128;

                amm_quote_break_even_amount_short_delta =
                    -perp_position_before.quote_break_even_amount as i128;
                amm_quote_break_even_amount_long_delta =
                    perp_position_after.quote_break_even_amount as i128;
            }
        }
    } else if delta.base_asset_amount < 0 {
        if perp_position_before.base_asset_amount <= 0 {
            amm_base_asset_amount_short_delta = delta.base_asset_amount as i128;
            amm_quote_entry_amount_short_delta = delta.quote_asset_amount as i128;
            amm_quote_break_even_amount_short_delta = delta.quote_asset_amount as i128;
        } else {
            if delta.base_asset_amount.abs() <= perp_position_before.base_asset_amount.abs() {
                amm_base_asset_amount_long_delta = delta.base_asset_amount as i128;
                amm_quote_entry_amount_long_delta = -(perp_position_before.quote_entry_amount
                    - perp_position_after.quote_entry_amount)
                    as i128;
                amm_quote_break_even_amount_long_delta =
                    -(perp_position_before.quote_break_even_amount
                        - perp_position_after.quote_break_even_amount) as i128;
            } else {
                amm_base_asset_amount_long_delta =
                    -perp_position_before.base_asset_amount.abs() as i128;
                amm_base_asset_amount_short_delta = -(delta.base_asset_amount.abs()
                    - perp_position_before.base_asset_amount.abs())
                    as i128;

                amm_quote_entry_amount_long_delta =
                    -perp_position_before.quote_entry_amount as i128;
                amm_quote_entry_amount_short_delta = perp_position_after.quote_entry_amount as i128;

                amm_quote_break_even_amount_long_delta =
                    -perp_position_before.quote_break_even_amount as i128;
                amm_quote_break_even_amount_short_delta =
                    perp_position_after.quote_break_even_amount as i128;
            }
        }
    }

    let expected_amm_base_asset_delta =
        perp_market_before.amm.base_asset_amount_long + amm_base_asset_amount_long_delta;
    assert_eq!(
        perp_market_after.amm.base_asset_amount_long,
        expected_amm_base_asset_delta
    );

    let expected_amm_base_asset_delta =
        perp_market_before.amm.base_asset_amount_short + amm_base_asset_amount_short_delta;
    assert_eq!(
        perp_market_after.amm.base_asset_amount_short,
        expected_amm_base_asset_delta
    );

    let net_amm_base_asset_amount = perp_market_after.amm.base_asset_amount_long
        + perp_market_after.amm.base_asset_amount_short;

    let expected_net_amm_base_asset_amount = perp_market_before.amm.base_asset_amount_long
        + perp_market_before.amm.base_asset_amount_short
        + delta.base_asset_amount as i128;

    assert_eq!(
        net_amm_base_asset_amount,
        expected_net_amm_base_asset_amount
    );

    let expected_amm_quote_entry_amount_long =
        perp_market_before.amm.quote_entry_amount_long + amm_quote_entry_amount_long_delta;
    assert_eq!(
        perp_market_after.amm.quote_entry_amount_long,
        expected_amm_quote_entry_amount_long
    );

    let expected_amm_quote_entry_amount_short =
        perp_market_before.amm.quote_entry_amount_short + amm_quote_entry_amount_short_delta;
    assert_eq!(
        perp_market_after.amm.quote_entry_amount_short,
        expected_amm_quote_entry_amount_short
    );

    let expected_amm_quote_break_even_amount_long =
        perp_market_before.amm.quote_break_even_amount_long
            + amm_quote_break_even_amount_long_delta;

    assert_eq!(
        perp_market_after.amm.quote_break_even_amount_long,
        expected_amm_quote_break_even_amount_long
    );

    let expected_amm_quote_break_even_amount_short =
        perp_market_before.amm.quote_break_even_amount_short
            + amm_quote_break_even_amount_short_delta;

    assert_eq!(
        perp_market_after.amm.quote_break_even_amount_short,
        expected_amm_quote_break_even_amount_short
    );
}
