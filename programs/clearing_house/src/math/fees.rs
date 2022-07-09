use crate::error::ClearingHouseResult;
use crate::math::casting::cast_to_u128;
use crate::math_error;
use crate::state::state::FeeStructure;
use crate::state::state::OrderFillerRewardStructure;
use num_integer::Roots;
use solana_program::msg;
use std::cmp::{max, min};

pub fn calculate_fee_for_order_fulfill_against_amm(
    quote_asset_amount: u128,
    fee_structure: &FeeStructure,
    order_ts: i64,
    now: i64,
    reward_filler: bool,
    quote_asset_amount_surplus: u128,
    is_post_only: bool,
) -> ClearingHouseResult<(u128, u128, u128)> {
    // if there was a quote_asset_amount_surplus, the order was a maker order and fee_to_market comes from surplus
    if is_post_only {
        let fee = quote_asset_amount_surplus;
        let filler_reward: u128 = if !reward_filler {
            0
        } else {
            calculate_filler_reward(fee, order_ts, now, &fee_structure.filler_reward_structure)?
        };
        let fee_minus_filler_reward = fee.checked_sub(filler_reward).ok_or_else(math_error!())?;
        let fee_to_market = fee_minus_filler_reward;
        let user_fee = 0_u128;

        Ok((user_fee, fee_to_market, filler_reward))
    } else {
        let fee = quote_asset_amount
            .checked_mul(fee_structure.fee_numerator)
            .ok_or_else(math_error!())?
            .checked_div(fee_structure.fee_denominator)
            .ok_or_else(math_error!())?;

        let user_fee = fee;

        let filler_reward: u128 = if !reward_filler {
            0
        } else {
            calculate_filler_reward(
                user_fee,
                order_ts,
                now,
                &fee_structure.filler_reward_structure,
            )?
        };

        let fee_to_market = user_fee
            .checked_sub(filler_reward)
            .ok_or_else(math_error!())?
            .checked_add(quote_asset_amount_surplus)
            .ok_or_else(math_error!())?;

        Ok((user_fee, fee_to_market, filler_reward))
    }
}

fn calculate_filler_reward(
    fee: u128,
    order_ts: i64,
    now: i64,
    filler_reward_structure: &OrderFillerRewardStructure,
) -> ClearingHouseResult<u128> {
    // incentivize keepers to prioritize filling older orders (rather than just largest orders)
    // for sufficiently small-sized order, reward based on fraction of fee paid

    let size_filler_reward = fee
        .checked_mul(filler_reward_structure.reward_numerator)
        .ok_or_else(math_error!())?
        .checked_div(filler_reward_structure.reward_denominator)
        .ok_or_else(math_error!())?;

    let min_time_filler_reward = filler_reward_structure.time_based_reward_lower_bound;
    let time_since_order = max(
        1,
        cast_to_u128(now.checked_sub(order_ts).ok_or_else(math_error!())?)?,
    );
    let time_filler_reward = time_since_order
        .checked_mul(100_000_000) // 1e8
        .ok_or_else(math_error!())?
        .nth_root(4)
        .checked_mul(min_time_filler_reward)
        .ok_or_else(math_error!())?
        .checked_div(100) // 1e2 = sqrt(sqrt(1e8))
        .ok_or_else(math_error!())?;

    // lesser of size-based and time-based reward
    let fee = min(size_filler_reward, time_filler_reward);

    Ok(fee)
}

pub fn calculate_fee_for_fulfillment_with_match(
    quote_asset_amount: u128,
    quote_asset_amount_surplus: u128,
    fee_structure: &FeeStructure,
    order_ts: i64,
    now: i64,
    reward_filler: bool,
) -> ClearingHouseResult<(u128, u128, u128, u128)> {
    let (taker_fee, maker_rebate, fee_to_market, filler_reward) = if quote_asset_amount_surplus == 0
    {
        let fee = quote_asset_amount
            .checked_mul(fee_structure.fee_numerator)
            .ok_or_else(math_error!())?
            .checked_div(fee_structure.fee_denominator)
            .ok_or_else(math_error!())?;

        let maker_rebate = fee
            .checked_mul(fee_structure.maker_rebate_numerator)
            .ok_or_else(math_error!())?
            .checked_div(fee_structure.maker_rebate_denominator)
            .ok_or_else(math_error!())?;

        let taker_fee = fee;

        let filler_reward: u128 = if !reward_filler {
            0
        } else {
            calculate_filler_reward(fee, order_ts, now, &fee_structure.filler_reward_structure)?
        };

        let fee_to_market = taker_fee
            .checked_sub(filler_reward)
            .ok_or_else(math_error!())?
            .checked_sub(maker_rebate)
            .ok_or_else(math_error!())?;

        (taker_fee, maker_rebate, fee_to_market, filler_reward)
    } else {
        let filler_reward: u128 = if !reward_filler {
            0
        } else {
            calculate_filler_reward(
                quote_asset_amount_surplus,
                order_ts,
                now,
                &fee_structure.filler_reward_structure,
            )?
        };

        let fee_to_market = quote_asset_amount_surplus
            .checked_sub(filler_reward)
            .ok_or_else(math_error!())?;

        (0, 0, fee_to_market, filler_reward)
    };

    Ok((taker_fee, maker_rebate, fee_to_market, filler_reward))
}

#[cfg(test)]
mod test {

    mod calculate_fee_for_taker_and_maker {
        use crate::math::constants::QUOTE_PRECISION;
        use crate::math::fees::calculate_fee_for_fulfillment_with_match;
        use crate::state::state::FeeStructure;

        #[test]
        fn no_filler() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;
            let quote_asset_amount_surplus = 0_u128;

            let (taker_fee, maker_rebate, fee_to_market, filler_reward) =
                calculate_fee_for_fulfillment_with_match(
                    quote_asset_amount,
                    quote_asset_amount_surplus,
                    &FeeStructure::default(),
                    0,
                    0,
                    false,
                )
                .unwrap();

            assert_eq!(taker_fee, 100000);
            assert_eq!(maker_rebate, 60000);
            assert_eq!(fee_to_market, 40000);
            assert_eq!(filler_reward, 0);
        }

        #[test]
        fn filler_size_reward() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;
            let quote_asset_amount_surplus = 0_u128;

            let mut fee_structure = FeeStructure::default();
            fee_structure
                .filler_reward_structure
                .time_based_reward_lower_bound = 10000000000000000; // big number

            let (taker_fee, maker_rebate, fee_to_market, filler_reward) =
                calculate_fee_for_fulfillment_with_match(
                    quote_asset_amount,
                    quote_asset_amount_surplus,
                    &fee_structure,
                    0,
                    0,
                    true,
                )
                .unwrap();

            assert_eq!(taker_fee, 100000);
            assert_eq!(maker_rebate, 60000);
            assert_eq!(fee_to_market, 30000);
            assert_eq!(filler_reward, 10000);
        }

        #[test]
        fn time_reward_no_time_passed() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;
            let quote_asset_amount_surplus = 0_u128;

            let mut fee_structure = FeeStructure::default();
            fee_structure.filler_reward_structure.reward_numerator = 1; // will make size reward the whole fee
            fee_structure.filler_reward_structure.reward_denominator = 1;

            let (taker_fee, maker_rebate, fee_to_market, filler_reward) =
                calculate_fee_for_fulfillment_with_match(
                    quote_asset_amount,
                    quote_asset_amount_surplus,
                    &fee_structure,
                    0,
                    0,
                    true,
                )
                .unwrap();

            assert_eq!(taker_fee, 100000);
            assert_eq!(maker_rebate, 60000);
            assert_eq!(fee_to_market, 30000);
            assert_eq!(filler_reward, 10000);
        }

        #[test]
        fn time_reward_time_passed() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;
            let quote_asset_amount_surplus = 0_u128;

            let mut fee_structure = FeeStructure::default();
            fee_structure.filler_reward_structure.reward_numerator = 1; // will make size reward the whole fee
            fee_structure.filler_reward_structure.reward_denominator = 1;

            let (taker_fee, maker_rebate, fee_to_market, filler_reward) =
                calculate_fee_for_fulfillment_with_match(
                    quote_asset_amount,
                    quote_asset_amount_surplus,
                    &fee_structure,
                    0,
                    60,
                    true,
                )
                .unwrap();

            assert_eq!(taker_fee, 100000);
            assert_eq!(maker_rebate, 60000);
            assert_eq!(fee_to_market, 12200);
            assert_eq!(filler_reward, 27800);
        }

        #[test]
        fn quote_asset_surplus() {
            let quote_asset_amount = 0;
            let quote_asset_amount_surplus = 100 * QUOTE_PRECISION;

            let mut fee_structure = FeeStructure::default();

            let (taker_fee, maker_rebate, fee_to_market, filler_reward) =
                calculate_fee_for_fulfillment_with_match(
                    quote_asset_amount,
                    quote_asset_amount_surplus,
                    &fee_structure,
                    0,
                    0,
                    true,
                )
                .unwrap();

            assert_eq!(taker_fee, 0);
            assert_eq!(maker_rebate, 0);
            assert_eq!(fee_to_market, 99990000);
            assert_eq!(filler_reward, 10000);
        }
    }
}
