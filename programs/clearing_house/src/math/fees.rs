use crate::error::ClearingHouseResult;
use crate::math::casting::cast_to_u128;
use crate::math::helpers::get_proportion_u128;
use crate::math_error;
use crate::state::state::FeeStructure;
use crate::state::state::OrderFillerRewardStructure;
use num_integer::Roots;
use solana_program::msg;
use std::cmp::{max, min};

use super::casting::cast_to_i128;

pub struct FillFees {
    pub user_fee: u128,
    pub maker_rebate: u128,
    pub fee_to_market: i128,
    pub fee_to_market_for_lp: i128,
    pub filler_reward: u128,
    pub referee_discount: u128,
    pub referrer_reward: u128,
}

pub fn calculate_fee_for_order_fulfill_against_amm(
    quote_asset_amount: u128,
    fee_structure: &FeeStructure,
    order_ts: i64,
    now: i64,
    reward_filler: bool,
    reward_referrer: bool,
    quote_asset_amount_surplus: i128,
    is_post_only: bool,
) -> ClearingHouseResult<FillFees> {
    // if there was a quote_asset_amount_surplus, the order was a maker order and fee_to_market comes from surplus
    if is_post_only {
        let fee = cast_to_u128(quote_asset_amount_surplus)?;
        let filler_reward: u128 = if !reward_filler {
            0
        } else {
            calculate_filler_reward(fee, order_ts, now, &fee_structure.filler_reward_structure)?
        };
        let fee_to_market =
            cast_to_i128(fee.checked_sub(filler_reward).ok_or_else(math_error!())?)?;
        let user_fee = 0_u128;

        Ok(FillFees {
            user_fee,
            maker_rebate: 0,
            fee_to_market,
            fee_to_market_for_lp: 0,
            filler_reward,
            referee_discount: 0,
            referrer_reward: 0,
        })
    } else {
        let fee = quote_asset_amount
            .checked_mul(fee_structure.fee_numerator)
            .ok_or_else(math_error!())?
            .checked_div(fee_structure.fee_denominator)
            .ok_or_else(math_error!())?;

        let (referrer_reward, referee_discount) = if reward_referrer {
            calculate_referrer_reward_and_referee_discount(fee, fee_structure)?
        } else {
            (0, 0)
        };

        let user_fee = fee
            .checked_sub(referee_discount)
            .ok_or_else(math_error!())?;

        let filler_reward: u128 = if !reward_filler {
            0
        } else {
            calculate_filler_reward(fee, order_ts, now, &fee_structure.filler_reward_structure)?
        };

        let fee_to_market = cast_to_i128(
            user_fee
                .checked_sub(filler_reward)
                .ok_or_else(math_error!())?
                .checked_sub(referrer_reward)
                .ok_or_else(math_error!())?,
        )?
        .checked_add(quote_asset_amount_surplus)
        .ok_or_else(math_error!())?;

        let fee_to_market_for_lp = fee_to_market
            .checked_sub(quote_asset_amount_surplus)
            .ok_or_else(math_error!())?;

        Ok(FillFees {
            user_fee,
            maker_rebate: 0,
            fee_to_market,
            fee_to_market_for_lp,
            filler_reward,
            referee_discount,
            referrer_reward,
        })
    }
}

fn calculate_referrer_reward_and_referee_discount(
    fee: u128,
    fee_structure: &FeeStructure,
) -> ClearingHouseResult<(u128, u128)> {
    Ok((
        get_proportion_u128(
            fee,
            fee_structure.referral_discount.referrer_reward_numerator,
            fee_structure.referral_discount.referrer_reward_denominator,
        )?,
        get_proportion_u128(
            fee,
            fee_structure.referral_discount.referee_discount_numerator,
            fee_structure.referral_discount.referee_discount_denominator,
        )?,
    ))
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
    fee_structure: &FeeStructure,
    order_ts: i64,
    now: i64,
    reward_filler: bool,
    reward_referrer: bool,
) -> ClearingHouseResult<FillFees> {
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

    let (referrer_reward, referee_discount) = if reward_referrer {
        calculate_referrer_reward_and_referee_discount(fee, fee_structure)?
    } else {
        (0, 0)
    };

    let taker_fee = fee
        .checked_sub(referee_discount)
        .ok_or_else(math_error!())?;

    let filler_reward: u128 = if !reward_filler {
        0
    } else {
        calculate_filler_reward(fee, order_ts, now, &fee_structure.filler_reward_structure)?
    };

    // must be non-negative
    let fee_to_market = cast_to_i128(
        taker_fee
            .checked_sub(filler_reward)
            .ok_or_else(math_error!())?
            .checked_sub(referrer_reward)
            .ok_or_else(math_error!())?
            .checked_sub(maker_rebate)
            .ok_or_else(math_error!())?,
    )?;

    Ok(FillFees {
        user_fee: taker_fee,
        maker_rebate,
        fee_to_market,
        filler_reward,
        referee_discount,
        referrer_reward,
        fee_to_market_for_lp: 0,
    })
}

#[cfg(test)]
mod test {

    mod calculate_fee_for_taker_and_maker {
        use crate::math::constants::QUOTE_PRECISION;
        use crate::math::fees::{calculate_fee_for_fulfillment_with_match, FillFees};
        use crate::state::state::{FeeStructure, ReferralDiscount};

        #[test]
        fn no_filler() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;

            let FillFees {
                user_fee: taker_fee,
                maker_rebate,
                fee_to_market,
                filler_reward,
                referee_discount,
                referrer_reward,
                ..
            } = calculate_fee_for_fulfillment_with_match(
                quote_asset_amount,
                &FeeStructure::default(),
                0,
                0,
                false,
                false,
            )
            .unwrap();

            assert_eq!(taker_fee, 100000);
            assert_eq!(maker_rebate, 60000);
            assert_eq!(fee_to_market, 40000);
            assert_eq!(filler_reward, 0);
            assert_eq!(referrer_reward, 0);
            assert_eq!(referee_discount, 0);
        }

        #[test]
        fn filler_size_reward() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;

            let mut fee_structure = FeeStructure::default();
            fee_structure
                .filler_reward_structure
                .time_based_reward_lower_bound = 10000000000000000; // big number

            let FillFees {
                user_fee: taker_fee,
                maker_rebate,
                fee_to_market,
                filler_reward,
                referee_discount,
                referrer_reward,
                ..
            } = calculate_fee_for_fulfillment_with_match(
                quote_asset_amount,
                &fee_structure,
                0,
                0,
                true,
                false,
            )
            .unwrap();

            assert_eq!(taker_fee, 100000);
            assert_eq!(maker_rebate, 60000);
            assert_eq!(fee_to_market, 30000);
            assert_eq!(filler_reward, 10000);
            assert_eq!(referrer_reward, 0);
            assert_eq!(referee_discount, 0);
        }

        #[test]
        fn time_reward_no_time_passed() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;

            let mut fee_structure = FeeStructure::default();
            fee_structure.filler_reward_structure.reward_numerator = 1; // will make size reward the whole fee
            fee_structure.filler_reward_structure.reward_denominator = 1;

            let FillFees {
                user_fee: taker_fee,
                maker_rebate,
                fee_to_market,
                filler_reward,
                referee_discount,
                referrer_reward,
                ..
            } = calculate_fee_for_fulfillment_with_match(
                quote_asset_amount,
                &fee_structure,
                0,
                0,
                true,
                false,
            )
            .unwrap();

            assert_eq!(taker_fee, 100000);
            assert_eq!(maker_rebate, 60000);
            assert_eq!(fee_to_market, 30000);
            assert_eq!(filler_reward, 10000);
            assert_eq!(referrer_reward, 0);
            assert_eq!(referee_discount, 0);
        }

        #[test]
        fn time_reward_time_passed() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;

            let mut fee_structure = FeeStructure::default();
            fee_structure.filler_reward_structure.reward_numerator = 1; // will make size reward the whole fee
            fee_structure.filler_reward_structure.reward_denominator = 1;

            let FillFees {
                user_fee: taker_fee,
                maker_rebate,
                fee_to_market,
                filler_reward,
                referee_discount,
                referrer_reward,
                ..
            } = calculate_fee_for_fulfillment_with_match(
                quote_asset_amount,
                &fee_structure,
                0,
                60,
                true,
                false,
            )
            .unwrap();

            assert_eq!(taker_fee, 100000);
            assert_eq!(maker_rebate, 60000);
            assert_eq!(fee_to_market, 12200);
            assert_eq!(filler_reward, 27800);
            assert_eq!(referrer_reward, 0);
            assert_eq!(referee_discount, 0);
        }

        #[test]
        fn referrer() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;

            let fee_structure = FeeStructure {
                referral_discount: ReferralDiscount {
                    referrer_reward_numerator: 1,
                    referrer_reward_denominator: 10,
                    referee_discount_numerator: 1,
                    referee_discount_denominator: 10,
                },
                ..FeeStructure::default()
            };

            let FillFees {
                user_fee: taker_fee,
                maker_rebate,
                fee_to_market,
                filler_reward,
                referee_discount,
                referrer_reward,
                ..
            } = calculate_fee_for_fulfillment_with_match(
                quote_asset_amount,
                &fee_structure,
                0,
                0,
                false,
                true,
            )
            .unwrap();

            assert_eq!(taker_fee, 90000);
            assert_eq!(maker_rebate, 60000);
            assert_eq!(fee_to_market, 20000);
            assert_eq!(filler_reward, 0);
            assert_eq!(referrer_reward, 10000);
            assert_eq!(referee_discount, 10000);
        }
    }

    mod calculate_fee_for_order_fulfill_against_amm {
        use crate::math::constants::QUOTE_PRECISION;
        use crate::math::fees::{calculate_fee_for_order_fulfill_against_amm, FillFees};
        use crate::state::state::{FeeStructure, ReferralDiscount};

        #[test]
        fn referrer() {
            let quote_asset_amount = 100 * QUOTE_PRECISION;

            let fee_structure = FeeStructure {
                referral_discount: ReferralDiscount {
                    referrer_reward_numerator: 1,
                    referrer_reward_denominator: 10,
                    referee_discount_numerator: 1,
                    referee_discount_denominator: 10,
                },
                ..FeeStructure::default()
            };

            let FillFees {
                user_fee,
                fee_to_market,
                filler_reward,
                referee_discount,
                referrer_reward,
                ..
            } = calculate_fee_for_order_fulfill_against_amm(
                quote_asset_amount,
                &fee_structure,
                0,
                60,
                false,
                true,
                0,
                false,
            )
            .unwrap();

            assert_eq!(user_fee, 90000);
            assert_eq!(fee_to_market, 80000);
            assert_eq!(filler_reward, 0);
            assert_eq!(referrer_reward, 10000);
            assert_eq!(referee_discount, 10000);
        }
    }
}
